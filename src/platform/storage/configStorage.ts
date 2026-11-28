/**
 * @file src/platform/storage/configStorage.ts
 *
 * 文件职责：为共享配置 store 提供统一持久化端口，在后台连接加密 IndexedDB，在扩展页面与 content 上下文通过受控 runtime 消息代理读取和订阅。
 * 主要内容：声明配置记录键、主记录存在时的 IndexedDB 直接短路、带加密清理标记的后台旧 storage 原子迁移与验证、会话随机密钥材料与旧 Firefox 内存降级、可选原子条件写与多键提交、隔离异常的 watch 通知，以及能在并发回读中保留变更意图的非后台只读适配器。
 * 模块边界：本文件不理解 Config 字段、不决定凭据授权、不选择真实浏览器运行上下文；configStorageRuntime 负责装配 WXT legacy storage、后台 repository 或远程 runtime，userscript 构建在该边界替换为 GM storage。
 * 旧值读取：后台端口只为凭据键在写入前读取旧值，其他键不再额外解密。
 */

import type {EncryptedConfigRepository} from './configRepository';

export const CONFIG_STORAGE_READ_MESSAGE = 'configStorageRead' as const;
export const CONFIG_STORAGE_CHANGED_MESSAGE = 'configStorageChanged' as const;
export const CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY = 'session:configIndexedDbKeyMaterial' as const;

export const CONFIG_INDEXED_DB_KEYS = [
    'local:config',
    'local:configHistory',
    'local:configAutoBackups',
    'local:credentials',
    'session:credentials',
    'local:fluentReadImageOcrLanguages',
] as const;
export const CONFIG_PRIMARY_INDEXED_DB_KEY = CONFIG_INDEXED_DB_KEYS[0];
export const CONFIG_LEGACY_CLEANUP_MARKER_KEY = 'meta:legacyStorageCleanupPending' as const;

export type ConfigIndexedDbKey = typeof CONFIG_INDEXED_DB_KEYS[number];
type ConfigStorageListener = (nextValue: unknown, previousValue?: unknown) => void;
/** 只有凭据键的后台订阅需要旧值比较；其他键写入前不再额外解密读取一次旧记录。 */
const CONFIG_KEYS_WITH_PREVIOUS_VALUE: ReadonlySet<string> = new Set(['local:credentials', 'session:credentials']);

interface UnverifiedLegacyCleanupMarker {
    version: 1;
    state: 'unverified';
    records: Array<{
        key: ConfigIndexedDbKey;
        digest?: string;
    }>;
}

interface VerifiedLegacyCleanupMarker {
    version: 1;
    state: 'verified';
    keys: ConfigIndexedDbKey[];
}

type LegacyCleanupMarker = UnverifiedLegacyCleanupMarker | VerifiedLegacyCleanupMarker;

export interface ConfigStoragePort {
    readonly writeOwner?: boolean;
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<void>;
    /** 可选原子条件写；缺少此能力时自动基线/投影仅驻内存，显式捕获再普通写入。 */
    setItemIfUnchanged?<T>(key: string, expectedValue: unknown, value: T): Promise<boolean>;
    setItems?(entries: ReadonlyMap<string, unknown>, removeKeys?: readonly string[]): Promise<void>;
    removeItem(key: string): Promise<void>;
    watch<T>(key: string, callback: (nextValue: T | null, previousValue?: T | null) => void): () => void;
}

export interface LegacyConfigStoragePort {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<void>;
    removeItem(key: string): Promise<void>;
}

export interface ConfigStorageRuntimePort {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
        addListener(listener: (message: unknown) => void): void;
    };
}

export interface BackgroundConfigStorageOptions {
    repository: EncryptedConfigRepository;
    legacy: LegacyConfigStoragePort;
    logger?: Pick<Console, 'warn'>;
}

export interface SessionKeyMaterialProviderOptions {
    allowMemoryFallback?: boolean;
    logger?: Pick<Console, 'warn'>;
}

function comparable(value: unknown): string {
    return JSON.stringify(value);
}

async function configValueDigest(value: unknown): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持配置迁移校验');
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(comparable(value)),
    ));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isLegacyCleanupMarker(value: unknown): value is LegacyCleanupMarker {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<LegacyCleanupMarker> & {records?: unknown; keys?: unknown};
    if (candidate.version !== 1) return false;
    const allowedKeys = new Set<string>(CONFIG_INDEXED_DB_KEYS);
    const keys = new Set<string>();
    if (candidate.state === 'verified') {
        if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) return false;
        return candidate.keys.every(key => {
            if (typeof key !== 'string' || !allowedKeys.has(key) || keys.has(key)) return false;
            keys.add(key);
            return true;
        });
    }
    if (candidate.state !== 'unverified'
        || !Array.isArray(candidate.records)
        || candidate.records.length === 0) {
        return false;
    }
    return candidate.records.every(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
        const key = (record as {key?: unknown}).key;
        const digest = (record as {digest?: unknown}).digest;
        if (typeof key !== 'string' || !allowedKeys.has(key) || keys.has(key)) return false;
        if (key.startsWith('session:')) {
            if (digest !== undefined) return false;
        } else if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
            return false;
        }
        keys.add(key);
        return true;
    });
}

async function createLegacyCleanupMarker(
    entries: ReadonlyMap<string, unknown>,
): Promise<UnverifiedLegacyCleanupMarker> {
    return {
        version: 1,
        state: 'unverified',
        records: await Promise.all([...entries].map(async ([key, value]) => (
            key.startsWith('session:')
                ? {key: key as ConfigIndexedDbKey}
                : {key: key as ConfigIndexedDbKey, digest: await configValueDigest(value)}
        ))),
    };
}

function randomKeyMaterial(): string {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function isValidSessionKeyMaterial(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        const decoded = atob(value);
        return decoded.length === 32 && btoa(decoded) === value;
    } catch {
        return false;
    }
}

export function createSessionKeyMaterialProvider(
    legacy: LegacyConfigStoragePort,
    options: SessionKeyMaterialProviderOptions = {},
): () => Promise<string> {
    let pending: Promise<string> | null = null;
    const memoryFallback = options.allowMemoryFallback ? randomKeyMaterial() : null;
    const fallback = (error: unknown): string => {
        if (!memoryFallback) throw error;
        (options.logger || console).warn(
            '[FluentRead] storage.session 不可用，当前 Firefox 后台页改用内存会话材料',
            error,
        );
        return memoryFallback;
    };
    return () => {
        if (pending) return pending;
        pending = (async () => {
            let existing: unknown;
            try {
                existing = await legacy.getItem<unknown>(CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY);
            } catch (error) {
                return fallback(error);
            }
            if (isValidSessionKeyMaterial(existing)) return existing;
            const created = randomKeyMaterial();
            try {
                await legacy.setItem(CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY, created);
                const verified = await legacy.getItem<unknown>(CONFIG_SESSION_KEY_MATERIAL_STORAGE_KEY);
                if (verified !== created) throw new Error('配置会话密钥材料写入校验失败');
            } catch (error) {
                return fallback(error);
            }
            return created;
        })();
        pending.catch(() => {
            pending = null;
        });
        return pending;
    };
}

export function createBackgroundConfigStorage(options: BackgroundConfigStorageOptions): ConfigStoragePort {
    const legacy = options.legacy;
    const logger = options.logger || console;
    const repository = options.repository;
    const listeners = new Map<string, Set<ConfigStorageListener>>();
    let migration: Promise<void> | null = null;
    const readPrevious = async (key: string): Promise<unknown> => (
        CONFIG_KEYS_WITH_PREVIOUS_VALUE.has(key) ? repository.get(key) : undefined
    );

    const notify = (key: string, value: unknown, previousValue?: unknown) => {
        listeners.get(key)?.forEach(listener => {
            try {listener(value, previousValue);}
            catch (error) {logger.warn('[FluentRead] 配置存储订阅通知失败', error);}
        });
    };

    const cleanupLegacyKeys = async (keys: readonly string[]): Promise<boolean> => {
        let complete = true;
        for (const key of keys) {
            try {
                await legacy.removeItem(key);
            } catch (error) {
                complete = false;
                logger.warn(`[FluentRead] 旧配置键清理失败，但 IndexedDB 已成为权威源: ${key}`, error);
            }
        }
        return complete;
    };

    const clearCleanupMarker = async (): Promise<void> => {
        try {
            await repository.remove(CONFIG_LEGACY_CLEANUP_MARKER_KEY);
        } catch (error) {
            // 旧键已经全部删除，残留标记只会让下一次启动再次执行幂等清理，
            // 不应因此阻断已经可解密的 IndexedDB 主配置。
            logger.warn('[FluentRead] 旧配置清理标记暂时无法删除，将在下次启动重试', error);
        }
    };

    const validateCleanupMarker = async (): Promise<VerifiedLegacyCleanupMarker | null> => {
        let marker: unknown;
        try {
            marker = await repository.get(CONFIG_LEGACY_CLEANUP_MARKER_KEY);
        } catch (error) {
            logger.warn('[FluentRead] 旧配置清理标记无法解密，保留旧载体且继续使用 IndexedDB 主配置', error);
            return null;
        }
        if (marker === null) return null;
        if (!isLegacyCleanupMarker(marker)) {
            logger.warn('[FluentRead] 旧配置清理标记格式无效，保留旧载体且继续使用 IndexedDB 主配置');
            return null;
        }
        if (marker.state === 'verified') return marker;
        for (const record of marker.records) {
            let value: unknown;
            try {
                value = await repository.get(record.key);
                // 会话记录只验证当前材料能否通过 AES-GCM 认证，不在持久 marker 中
                // 留普通摘要；跨浏览器会话失效时 repository 会删除它并返回 null。
                if (value === null && record.key.startsWith('session:')) continue;
                if (value === null
                    || (record.digest !== undefined && await configValueDigest(value) !== record.digest)) {
                    logger.warn(`[FluentRead] IndexedDB 迁移记录校验失败，保留旧配置键: ${record.key}`);
                    return null;
                }
            } catch (error) {
                logger.warn(`[FluentRead] IndexedDB 迁移记录无法验证，保留旧配置键: ${record.key}`, error);
                return null;
            }
        }
        const verified: VerifiedLegacyCleanupMarker = {
            version: 1,
            state: 'verified',
            keys: marker.records.map(record => record.key),
        };
        // 读回验证成功后先持久化 keys-only 状态，再开始删除旧载体。此后配置可被
        // 正常化或继续修改，不会因摘要变化而让部分清理永久卡住。
        await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, verified);
        return verified;
    };

    const resumeLegacyCleanup = async (): Promise<void> => {
        if (!await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)) return;
        const marker = await validateCleanupMarker();
        if (!marker) return;
        const complete = await cleanupLegacyKeys(marker.keys);
        // 无主配置的旧快照迁移后，marker 必须继续充当 durable authority，直到
        // 默认 local:config 建立。否则慢实例可在 marker 清除后的空窗提交残缺快照。
        if (complete && await repository.has(CONFIG_PRIMARY_INDEXED_DB_KEY)) {
            await clearCleanupMarker();
        }
    };

    const ensureMigrated = (): Promise<void> => {
        if (migration) return migration;
        migration = (async () => {
            // 清理标记优先于主记录判断：旧版本可能只有历史或凭据，没有
            // local:config。此时中断恢复也必须沿用已迁入的完整快照，不能再次扫描
            // 残缺 legacy 后把已成功迁入、已成功清理的记录 bulkDelete 掉。
            if (await repository.has(CONFIG_LEGACY_CLEANUP_MARKER_KEY)) {
                await resumeLegacyCleanup();
                return;
            }
            // 没有待恢复迁移时，IndexedDB 主配置一旦存在就是唯一权威源；后续
            // 后台启动直接使用，完全不读取或清理旧 storage。
            if (await repository.has(CONFIG_PRIMARY_INDEXED_DB_KEY)) return;

            const legacyEntries = new Map<string, unknown>();
            for (const key of CONFIG_INDEXED_DB_KEYS) {
                let value: unknown;
                try {
                    value = await legacy.getItem<unknown>(key);
                } catch (error) {
                    // 较旧 Firefox 或受限运行时可能没有 storage.session。会话凭据本就
                    // 不能跨浏览器生命周期保证存在；不能因此阻断可用的本地配置迁移。
                    if (!key.startsWith('session:')) throw error;
                    logger.warn(`[FluentRead] 旧会话配置暂不可读，继续迁移持久配置: ${key}`, error);
                    continue;
                }
                if (value !== null && value !== undefined) legacyEntries.set(key, value);
            }
            if (legacyEntries.size === 0) return;

            // 清理标记与迁移数据同一个 IndexedDB 事务提交。即使后台在提交后、
            // 删除旧明文前退出，下次启动也只会重试清理，不会读取或回灌旧值。
            const migrationEntries = new Map(legacyEntries);
            migrationEntries.set(
                CONFIG_LEGACY_CLEANUP_MARKER_KEY,
                await createLegacyCleanupMarker(legacyEntries),
            );
            const imported = await repository.importMigrationSnapshotIfAuthorityMissing(
                [CONFIG_PRIMARY_INDEXED_DB_KEY, CONFIG_LEGACY_CLEANUP_MARKER_KEY],
                migrationEntries,
                [...CONFIG_INDEXED_DB_KEYS, CONFIG_LEGACY_CLEANUP_MARKER_KEY],
            );
            // 另一实例若先提交了完整主快照，本实例不得再补入自己的历史或凭据。
            // 它只恢复胜出快照自己的待清理标记，然后直接采用该 IndexedDB 配置。
            if (!imported) {
                await resumeLegacyCleanup();
                return;
            }
            for (const [key, expected] of legacyEntries) {
                const actual = await repository.get(key);
                if (comparable(actual) !== comparable(expected)) {
                    throw new Error(`配置迁移写入校验失败: ${key}`);
                }
            }

            // IndexedDB 已经提交并可解密后才清理旧载体。任一删除失败就保留加密
            // keys-only 标记；后续配置即使变化也只重试删除，不会读取旧值。
            await repository.set(CONFIG_LEGACY_CLEANUP_MARKER_KEY, {
                version: 1,
                state: 'verified',
                keys: [...legacyEntries.keys()] as ConfigIndexedDbKey[],
            } satisfies VerifiedLegacyCleanupMarker);
            const complete = await cleanupLegacyKeys([...legacyEntries.keys()]);
            if (complete && await repository.has(CONFIG_PRIMARY_INDEXED_DB_KEY)) {
                await clearCleanupMarker();
            }
        })();
        migration.catch(() => {
            migration = null;
        });
        return migration;
    };

    return {
        writeOwner: true,
        async getItem<T>(key: string): Promise<T | null> {
            await ensureMigrated();
            return repository.get<T>(key);
        },
        async setItem<T>(key: string, value: T): Promise<void> {
            await ensureMigrated();
            const previous = await readPrevious(key);
            await repository.set(key, value);
            notify(key, value, previous);
        },
        async setItemIfUnchanged<T>(key: string, expectedValue: unknown, value: T): Promise<boolean> {
            await ensureMigrated();
            const written = await repository.setIfUnchanged(key, expectedValue, value);
            if (written) notify(key, value, expectedValue);
            return written;
        },
        async setItems(entries: ReadonlyMap<string, unknown>, removeKeys: readonly string[] = []): Promise<void> {
            await ensureMigrated();
            const entryKeys = [...entries.keys()];
            const removedKeys = [...new Set(removeKeys)].filter(key => !entries.has(key));
            const affectedKeys = [...entryKeys, ...removedKeys];
            const previous = new Map(await Promise.all(affectedKeys.map(async key => (
                [key, await readPrevious(key)] as const
            ))));
            await repository.commitChanges(entries, removedKeys);
            entries.forEach((value, key) => notify(key, value, previous.get(key)));
            removedKeys.forEach(key => notify(key, null, previous.get(key)));
        },
        async removeItem(key: string): Promise<void> {
            await ensureMigrated();
            const previous = await readPrevious(key);
            await repository.remove(key);
            notify(key, null, previous);
        },
        watch<T>(key: string, callback: (nextValue: T | null, previousValue?: T | null) => void): () => void {
            const bucket = listeners.get(key) || new Set<ConfigStorageListener>();
            bucket.add(callback as ConfigStorageListener);
            listeners.set(key, bucket);
            return () => {
                bucket.delete(callback as ConfigStorageListener);
                if (bucket.size === 0) listeners.delete(key);
            };
        },
    };
}

interface ConfigStorageReadResponse {
    success?: boolean;
    error?: string;
    value?: unknown;
}

type SettledConfigStorageRead =
    | {ok: true; value: unknown}
    | {ok: false; error: unknown};

function isChangedMessage(value: unknown): value is {type: typeof CONFIG_STORAGE_CHANGED_MESSAGE; key: string} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {type?: unknown; key?: unknown};
    return candidate.type === CONFIG_STORAGE_CHANGED_MESSAGE && typeof candidate.key === 'string';
}

export function createRemoteConfigStorage(runtime: ConfigStorageRuntimePort): ConfigStoragePort {
    const listeners = new Map<string, Set<ConfigStorageListener>>();
    const values = new Map<string, unknown>();
    const latestReadRequests = new Map<string, Promise<SettledConfigStorageRead>>();
    const pendingNotificationKeys = new Set<string>();

    const waitForStableRead = async (
        key: string,
        initialRequest: Promise<SettledConfigStorageRead>,
    ): Promise<{owner: boolean; result: SettledConfigStorageRead}> => {
        let request = initialRequest;
        while (true) {
            const result = await request;
            const latestRequest = latestReadRequests.get(key)!;
            if (latestRequest !== request) {
                request = latestRequest;
                continue;
            }
            return {owner: request === initialRequest, result};
        }
    };

    const readItem = async <T>(key: string, notify = false): Promise<T | null> => {
        // 变更通知是键级意图，不能绑定在某一个具体读请求上。否则随后发起的
        // 显式 getItem 会成为 latest owner，但因自身 notify=false 而吞掉 watch 更新。
        if (notify) pendingNotificationKeys.add(key);
        const previous = values.get(key);
        const request = (async (): Promise<SettledConfigStorageRead> => {
            try {
                const response = await runtime.sendMessage({type: CONFIG_STORAGE_READ_MESSAGE, key}) as ConfigStorageReadResponse | undefined;
                if (response?.success === false) throw new Error(response.error || '后台读取配置失败');
                if (!response || response.success !== true) throw new Error('后台读取配置没有返回结果');
                return {ok: true, value: response.value ?? null};
            } catch (error) {
                return {ok: false, error};
            }
        })();
        latestReadRequests.set(key, request);
        const stable = await waitForStableRead(key, request);
        if (!stable.result.ok) throw stable.result.error;
        const value = stable.result.value;
        // 较早请求无论先到还是晚到，都必须等待当前最新请求并返回它的结果；只有
        // 最后发起请求的 owner 可以更新缓存或通知 watch，避免初始化采用陈旧快照。
        if (stable.owner) {
            values.set(key, value);
            if (pendingNotificationKeys.delete(key)) {
                listeners.get(key)?.forEach(listener => {
                    try {listener(value, previous);}
                    catch (error) {console.warn('[FluentRead] 配置存储订阅通知失败', error);}
                });
            }
        }
        return value as T | null;
    };

    const getItem = <T>(key: string): Promise<T | null> => readItem<T>(key);

    runtime.onMessage.addListener((message) => {
        if (!isChangedMessage(message)) return;
        const bucket = listeners.get(message.key);
        if (!bucket?.size) return;
        void readItem(message.key, true)
            .catch(error => console.warn('[FluentRead] 配置变更同步失败', error));
    });

    return {
        writeOwner: false,
        getItem,
        async setItem(): Promise<void> {
            throw new Error('当前上下文必须通过后台配置协议保存');
        },
        async setItems(): Promise<void> {
            throw new Error('当前上下文必须通过后台配置协议批量保存');
        },
        async removeItem(): Promise<void> {
            throw new Error('当前上下文必须通过后台配置协议删除');
        },
        watch<T>(key: string, callback: (nextValue: T | null, previousValue?: T | null) => void): () => void {
            const bucket = listeners.get(key) || new Set<ConfigStorageListener>();
            bucket.add(callback as ConfigStorageListener);
            listeners.set(key, bucket);
            return () => {
                bucket.delete(callback as ConfigStorageListener);
                if (bucket.size === 0) listeners.delete(key);
            };
        },
    };
}

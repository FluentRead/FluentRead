/**
 * @file src/platform/storage/privacyActivityRepository.ts
 * 文件职责：在扩展本地存储中串行化保存翻译隐私防护的脱敏与拦截记录及累计统计。
 * 主要内容：基于 WXT storage 提供独立键持久化、内存缓存、按代次失效的防竞态清空能力，以及面向测试的可注入存储端口；仅保存不可逆的星号摘要、类别计数、动作与服务标识。
 * 模块边界：不读取配置或凭据、不接触原文或完整敏感值、不进入普通导出或云同步；业务归一化与星号格式算法由 core/privacy/activity 提供。
 */
import {storage} from '@wxt-dev/storage';
import {
    appendPrivacyActivityRecord,
    createEmptyPrivacyActivitySnapshot,
    normalizePrivacyActivitySnapshot,
    type PrivacyActivityInput,
    type PrivacyActivitySnapshot,
} from '@/src/core/privacy/activity';

export const PRIVACY_ACTIVITY_STORAGE_KEY = 'local:privacyProtectionActivity:v1' as const;

export interface PrivacyActivityStoragePort {
    load: () => Promise<unknown>;
    save: (snapshot: PrivacyActivitySnapshot) => Promise<void>;
    remove?: () => Promise<void>;
}

export interface PrivacyActivityRepository {
    captureGeneration: () => number;
    record: (event: PrivacyActivityInput, generation?: number) => Promise<void>;
    getSnapshot: () => Promise<PrivacyActivitySnapshot>;
    clear: () => Promise<void>;
}

export interface PrivacyActivityRepositoryOptions {
    storage?: PrivacyActivityStoragePort;
    now?: () => number;
    warn?: (message: string, error: unknown) => void;
}

const defaultStoragePort: PrivacyActivityStoragePort = {
    load: () => storage.getItem(PRIVACY_ACTIVITY_STORAGE_KEY),
    save: snapshot => storage.setItem(PRIVACY_ACTIVITY_STORAGE_KEY, snapshot),
    remove: () => storage.removeItem(PRIVACY_ACTIVITY_STORAGE_KEY),
};

export function createPrivacyActivityRepository(
    options: PrivacyActivityRepositoryOptions = {},
): PrivacyActivityRepository {
    const port = options.storage ?? defaultStoragePort;
    const now = options.now ?? (() => Date.now());
    const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));

    let generation = 0;
    let cached: PrivacyActivitySnapshot | null = null;
    let queue: Promise<void> = Promise.resolve();

    function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = queue.then(task);
        queue = run.then(() => undefined);
        return run;
    }

    async function ensureLoaded(): Promise<PrivacyActivitySnapshot> {
        if (cached) return cached;
        try {
            cached = normalizePrivacyActivitySnapshot(await port.load());
        } catch (error) {
            warn('[FluentRead] privacy activity load failed:', error);
            cached = createEmptyPrivacyActivitySnapshot();
        }
        return cached;
    }

    return {
        captureGeneration(): number {
            return generation;
        },
        record(event: PrivacyActivityInput, eventGeneration = generation): Promise<void> {
            return enqueue(async () => {
                if (eventGeneration !== generation) return;
                const current = await ensureLoaded();
                if (eventGeneration !== generation) return;
                const next = appendPrivacyActivityRecord(current, event, now);
                cached = next;
                try {
                    await port.save(next);
                } catch (error) {
                    warn('[FluentRead] privacy activity save failed:', error);
                }
            });
        },
        getSnapshot(): Promise<PrivacyActivitySnapshot> {
            return enqueue(async () => {
                const current = await ensureLoaded();
                return {
                    stats: {
                        ...current.stats,
                        categoryCounts: {...current.stats.categoryCounts},
                    },
                    records: current.records.map(record => ({
                        ...record,
                        categoryCounts: {...record.categoryCounts},
                        samples: record.samples.map(sample => ({...sample})),
                    })),
                };
            });
        },
        clear(): Promise<void> {
            generation += 1;
            const clearedGeneration = generation;
            return enqueue(async () => {
                if (clearedGeneration !== generation) return;
                const empty = createEmptyPrivacyActivitySnapshot();
                cached = empty;
                try {
                    if (port.remove) await port.remove();
                    else await port.save(empty);
                } catch (error) {
                    warn('[FluentRead] privacy activity clear failed:', error);
                }
            });
        },
    };
}

let singleton: PrivacyActivityRepository | undefined;

export function getPrivacyActivityRepository(): PrivacyActivityRepository {
    if (!singleton) singleton = createPrivacyActivityRepository();
    return singleton;
}

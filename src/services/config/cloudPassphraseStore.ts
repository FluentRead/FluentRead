/**
 * @file src/services/config/cloudPassphraseStore.ts
 * 文件职责：在后台安全隔离并管理云备份自定义端到端加密口令的会话态与设备态留存。
 * 主要内容：按存储提供商分别记录口令模式、支持单次不留存、浏览器会话内临时保持与经本机加密仓库显式留存以供自动同步使用，提供一键清除遗忘并绝不向界面返回明文口令。
 * 模块边界：仅操作后台注入的会话存储和本机加密配置存储端口，绝不写入 browser.storage.sync、普通配置导出或日志输出。
 */
import {GOOGLE_DRIVE_APPLICATION_PASSPHRASE} from '@/src/platform/google-drive/constants';
import {DriveEncryptionError, validateDrivePassphrase, type DriveEncryptionKeyMode} from '@/src/platform/google-drive/encryption';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';

export type CloudPassphraseProvider = 'google-drive' | 'webdav';
export type CloudPassphraseRememberScope = 'none' | 'session' | 'device';

export interface CloudPassphraseStatus {
    mode: DriveEncryptionKeyMode;
    hasStoredPassphrase: boolean;
    storageScope: CloudPassphraseRememberScope;
}

export interface CloudPassphraseConfigInput {
    mode: DriveEncryptionKeyMode;
    passphrase?: string;
    rememberScope?: CloudPassphraseRememberScope;
}

export interface CloudPassphraseSessionStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
}

export interface CloudPassphraseStorePorts {
    provider: CloudPassphraseProvider;
    deviceStorage: Pick<ConfigStoragePort, 'getItem' | 'setItem' | 'removeItem'>;
    sessionStorage?: CloudPassphraseSessionStorage;
}

interface StoredModeRecord {
    version: 1;
    mode: DriveEncryptionKeyMode;
}

interface StoredDevicePassphraseRecord {
    version: 1;
    passphrase: string;
}

export function cloudPassphraseModeKey(provider: CloudPassphraseProvider): string {
    return `local:cloudSyncPassphraseMode:${provider}`;
}

export function cloudPassphraseDeviceKey(provider: CloudPassphraseProvider): string {
    return `local:cloudSyncCustomPassphrase:${provider}`;
}

export function cloudPassphraseSessionKey(provider: CloudPassphraseProvider): string {
    return `fluentread:cloudSyncSessionPassphrase:${provider}`;
}

export interface ResolvedCloudPassphrase {
    keyMode: DriveEncryptionKeyMode;
    passphrase: string;
    legacyPassphrase: string;
}

export function createCloudPassphraseStore(ports: CloudPassphraseStorePorts) {
    const modeKey = cloudPassphraseModeKey(ports.provider);
    const deviceKey = cloudPassphraseDeviceKey(ports.provider);
    const sessionKey = cloudPassphraseSessionKey(ports.provider);
    let memoryPassphrase: string | null = null;

    async function readMode(): Promise<DriveEncryptionKeyMode> {
        const record = await ports.deviceStorage.getItem<Partial<StoredModeRecord>>(modeKey);
        return record?.version === 1 && record.mode === 'custom' ? 'custom' : 'app';
    }

    async function readSessionPassphrase(): Promise<string | null> {
        if (ports.sessionStorage) {
            try {
                const record = await ports.sessionStorage.get(sessionKey);
                const candidate = record?.[sessionKey];
                if (typeof candidate === 'string' && candidate.trim().length >= 12) return candidate;
            } catch {
                // 会话存储不可用时回退到当前后台进程内存。
            }
        }
        return memoryPassphrase;
    }

    async function writeSessionPassphrase(passphrase: string | null): Promise<void> {
        memoryPassphrase = passphrase;
        if (!ports.sessionStorage) return;
        try {
            if (passphrase === null) await ports.sessionStorage.remove(sessionKey);
            else await ports.sessionStorage.set({[sessionKey]: passphrase});
        } catch {
            // 浏览器限制 session 存储时仅保留在内存，绝不降级到 sync 存储。
        }
    }

    async function readDevicePassphrase(): Promise<string | null> {
        const record = await ports.deviceStorage.getItem<Partial<StoredDevicePassphraseRecord>>(deviceKey);
        return record?.version === 1 && typeof record.passphrase === 'string' && record.passphrase.trim().length >= 12
            ? record.passphrase
            : null;
    }

    async function readStoredPassphrase(): Promise<{passphrase: string | null; scope: CloudPassphraseRememberScope}> {
        const device = await readDevicePassphrase();
        if (device) return {passphrase: device, scope: 'device'};
        const session = await readSessionPassphrase();
        if (session) return {passphrase: session, scope: 'session'};
        return {passphrase: null, scope: 'none'};
    }

    async function status(): Promise<CloudPassphraseStatus> {
        const mode = await readMode();
        if (mode === 'app') return {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'};
        const stored = await readStoredPassphrase();
        return {
            mode: 'custom',
            hasStoredPassphrase: stored.passphrase !== null,
            storageScope: stored.scope,
        };
    }

    async function configure(input: CloudPassphraseConfigInput): Promise<CloudPassphraseStatus> {
        if (!input || typeof input !== 'object' || (input.mode !== 'app' && input.mode !== 'custom')) {
            throw new DriveEncryptionError('加密口令模式无效', 'unsupported');
        }
        if (input.mode === 'app') {
            await ports.deviceStorage.setItem<StoredModeRecord>(modeKey, {version: 1, mode: 'app'});
            await ports.deviceStorage.removeItem(deviceKey);
            await writeSessionPassphrase(null);
            return {mode: 'app', hasStoredPassphrase: false, storageScope: 'none'};
        }
        const scope: CloudPassphraseRememberScope = input.rememberScope ?? 'session';
        if (scope !== 'none' && scope !== 'session' && scope !== 'device') {
            throw new DriveEncryptionError('口令留存范围无效', 'unsupported');
        }
        let effectivePassphrase = input.passphrase;
        if (effectivePassphrase !== undefined) {
            validateDrivePassphrase(effectivePassphrase);
        } else if (scope !== 'none') {
            const existing = await readStoredPassphrase();
            if (!existing.passphrase) {
                throw new DriveEncryptionError('请输入至少 12 个字符的自定义端到端同步口令', 'invalid-passphrase');
            }
            effectivePassphrase = existing.passphrase;
        }
        await ports.deviceStorage.setItem<StoredModeRecord>(modeKey, {version: 1, mode: 'custom'});
        if (scope === 'device') {
            await ports.deviceStorage.setItem<StoredDevicePassphraseRecord>(deviceKey, {version: 1, passphrase: effectivePassphrase!});
            await writeSessionPassphrase(null);
        } else if (scope === 'session') {
            await ports.deviceStorage.removeItem(deviceKey);
            await writeSessionPassphrase(effectivePassphrase!);
        } else {
            await ports.deviceStorage.removeItem(deviceKey);
            await writeSessionPassphrase(null);
        }
        return status();
    }

    async function clear(): Promise<CloudPassphraseStatus> {
        await ports.deviceStorage.removeItem(deviceKey);
        await writeSessionPassphrase(null);
        return status();
    }

    async function resolveForSync(override?: {keyMode?: DriveEncryptionKeyMode; passphrase?: string}): Promise<ResolvedCloudPassphrase> {
        const requestedMode = override?.keyMode ?? await readMode();
        if (requestedMode === 'app') {
            return {
                keyMode: 'app',
                passphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
                legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
            };
        }
        if (override?.passphrase !== undefined) {
            validateDrivePassphrase(override.passphrase);
            return {
                keyMode: 'custom',
                passphrase: override.passphrase,
                legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
            };
        }
        const stored = await readStoredPassphrase();
        if (!stored.passphrase) {
            throw new DriveEncryptionError('云端备份使用自定义端到端加密口令保护，请先输入同步口令。', 'passphrase-required');
        }
        return {
            keyMode: 'custom',
            passphrase: stored.passphrase,
            legacyPassphrase: GOOGLE_DRIVE_APPLICATION_PASSPHRASE,
        };
    }

    return {status, configure, clear, resolveForSync};
}

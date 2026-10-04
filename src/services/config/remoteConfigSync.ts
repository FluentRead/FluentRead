/**
 * @file src/services/config/remoteConfigSync.ts
 * 文件职责：编排 Google Drive 与 WebDAV 共用的范围化云备份和单次用户确认事务。
 * 主要内容：单次授权、账号绑定、上次成功同步的账号记录、密文基线、三方合并、
 * 掩码预览、只读恢复能力、过期检查与授权缓存清理；清理失败独立提示，不掩盖同步结果或原错误。
 * 模块边界：通过端口读写配置与云端存储；不持久化口令，不向设置页面传递完整配置。
 */
import {buildDriveSyncDiff, driveSyncPayload, driveValuesEqual, parseDriveSyncPayload, resolveDriveSyncDiff, toDriveSyncConfig, parseDriveSyncSnapshot, projectDriveSyncConfig, restoreDriveSyncSettings, validateDriveSyncConsent, type DriveSyncConfig, type DriveSyncDiff} from '@/src/core/config/driveSync';
import {decryptDriveConfig, encryptDriveConfig, decryptDrivePreview, encryptDrivePreview, validateDrivePassphrase} from '@/src/platform/google-drive/encryption';
import {CloudSyncError, type CloudSyncAccount as DriveAccount, type CloudSyncSession as DriveSession, type CloudSyncFile as DriveFile, type CloudSyncRemote as DriveRemote} from '@/src/core/config/cloudSync';

export interface DriveSyncState {
    version: 1;
    // 兼容已有状态：只标记待确认事务，完成、失败或取消后立即设为 false。
    connected: boolean;
    accountId: string;
    baseline: string;
    lastSyncedAt: number | null;
    lastSyncedAccount?: DriveAccount;
    cleanupPending?: true;
    prepared?: {id: string; expiresAt: number; content: string; tabId?: number; clientId?: string; format?: 2; scope?: 'settings' | 'complete'; remote?: DriveRemote | null};
}
export interface DriveSyncStatus {available: boolean; reason: string; account: DriveAccount | null; lastSyncedAt: number | null; cleanupPending?: true}
export interface DriveSyncPreview {
    id: string;
    account: DriveAccount;
    hasRemote: boolean;
    includeSensitive: boolean;
    remoteIncludesSensitive: boolean;
    hasBaseline: boolean;
    canUpload?: false;
    changes: DriveSyncDiff['changes'];
    expiresAt: number;
}
export type DriveSyncDirection = 'upload' | 'download' | 'merge';
export interface DriveSyncPorts<Session extends DriveSession = DriveSession> {
    auth: {availability(): {available: boolean; reason: string}; open(interactive?: boolean): Promise<Session>; disconnect(): Promise<void>};
    api: {read(session: Session): Promise<DriveRemote | null>; write(session: Session, content: string, previous: DriveFile | null): Promise<DriveFile>};
    snapshot(): Promise<Record<string, unknown>>;
    apply(config: DriveSyncConfig): Promise<void>;
    readState(): Promise<unknown>;
    writeState(state: DriveSyncState): Promise<void>;
    now(): number;
    accountChangedError?: string;
}
interface Pending {
    preview: DriveSyncPreview;
    local: DriveSyncConfig;
    originalLocal: DriveSyncConfig;
    remote: DriveRemote | null;
    remoteConfig: DriveSyncConfig | null;
    diff: DriveSyncDiff | null;
    proof: string;
}
function emptyState(): DriveSyncState {return {version: 1, connected: false, accountId: '', baseline: '', lastSyncedAt: null};}
function readState(value: unknown): DriveSyncState {
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('connected' in value) || typeof value.connected !== 'boolean' || !('accountId' in value) || typeof value.accountId !== 'string' || !('baseline' in value) || typeof value.baseline !== 'string' || !('lastSyncedAt' in value) || !(value.lastSyncedAt === null || typeof value.lastSyncedAt === 'number')) return emptyState();
    const prepared = 'prepared' in value ? value.prepared as DriveSyncState['prepared'] : undefined;
    const lastAccount = 'lastSyncedAccount' in value ? value.lastSyncedAccount as Partial<DriveAccount> | null : null;
    return {version: 1, connected: value.connected, accountId: value.accountId, baseline: value.baseline, lastSyncedAt: value.lastSyncedAt,
        ...(lastAccount && typeof lastAccount.id === 'string' && typeof lastAccount.email === 'string' ? {lastSyncedAccount: {id: lastAccount.id, email: lastAccount.email}} : {}),
        ...('cleanupPending' in value && value.cleanupPending === true ? {cleanupPending: true as const} : {}),
        ...(prepared && typeof prepared.id === 'string' && typeof prepared.expiresAt === 'number' && typeof prepared.content === 'string' ? {prepared} : {}),
    };
}
async function proof(id: string, passphrase: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${id}:${passphrase}`));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function sameRemote(left: DriveRemote | null, right: DriveRemote | null): boolean {
    return left === null ? right === null : right !== null && left.file.id === right.file.id && left.file.version === right.file.version && left.content === right.content;
}
function owns(state: DriveSyncState, tabId?: number, clientId?: string): boolean {
    return state.prepared?.tabId === tabId && state.prepared?.clientId === clientId;
}
export function createRemoteConfigSync<Session extends DriveSession>(ports: DriveSyncPorts<Session>) {
    let pending: Pending | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    function exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    }
    async function finishSession(): Promise<void> {
        pending = null;
        let state: DriveSyncState | undefined;
        try {
            state = readState(await ports.readState());
            const changed = state.connected || Boolean(state.prepared);
            delete state.prepared;
            state.connected = false;
            if (changed) await ports.writeState(state);
        } finally {
            try {await ports.auth.disconnect();}
            catch (error) {
                if (state) await ports.writeState({...state, cleanupPending: true});
                throw error;
            }
        }
        if (state.cleanupPending) {
            delete state.cleanupPending;
            await ports.writeState(state);
        }
    }
    async function status(): Promise<DriveSyncStatus> {
        const availability = ports.auth.availability();
        const state = readState(await ports.readState());
        // 打开设置不获取令牌；顺便清理旧实现留下的连接或已经过期的事务。
        let cleanupPending = state.cleanupPending;
        if (cleanupPending || state.connected && (!state.prepared || state.prepared.expiresAt <= ports.now())) {
            try {await finishSession(); cleanupPending = undefined;} catch {cleanupPending = true;}
        }
        return {...availability, account: state.lastSyncedAccount ?? null, lastSyncedAt: state.lastSyncedAt, ...(cleanupPending ? {cleanupPending} : {})};
    }
    async function prepare(passphrase: string, tabId?: number, clientId?: string, includeSensitive = false): Promise<DriveSyncPreview> {
        validateDriveSyncConsent(includeSensitive);
        validateDrivePassphrase(passphrase);
        pending = null;
        const session = await ports.auth.open(true);
        const previous = readState(await ports.readState());
        // 换账号只重置合并基线；取消或授权失败时仍能看到上次成功同步的账号及时间。
        const state = previous.accountId === session.account.id ? previous : {...emptyState(), lastSyncedAt: previous.lastSyncedAt, ...(previous.lastSyncedAccount ? {lastSyncedAccount: previous.lastSyncedAccount} : {})};
        delete state.prepared;
        const originalLocal = structuredClone(await ports.snapshot());
        const local = toDriveSyncConfig(originalLocal);
        const remote = await ports.api.read(session);
        const remoteSnapshot = remote ? parseDriveSyncSnapshot(await decryptDriveConfig(remote.content, passphrase)) : null;
        const remoteIncludesSensitive = remoteSnapshot?.includesSensitive ?? false;
        const sensitiveDiff = includeSensitive && remoteIncludesSensitive;
        const remoteConfig = remoteSnapshot ? projectDriveSyncConfig(remoteSnapshot.config, sensitiveDiff) : null;
        let baseline: DriveSyncConfig | null = null;
        if (remote && state.accountId === session.account.id && state.baseline) {
            // 普通基线不能给新增的敏感差异提供删除建议；完整基线可安全投影成普通设置。
            try {
                const snapshot = parseDriveSyncSnapshot(await decryptDriveConfig(state.baseline, passphrase));
                if (!sensitiveDiff || snapshot.includesSensitive) baseline = projectDriveSyncConfig(snapshot.config, sensitiveDiff);
            } catch {baseline = null;}
        }
        const diff = remoteConfig ? buildDriveSyncDiff(baseline, projectDriveSyncConfig(local, sensitiveDiff), remoteConfig) : null;
        const preview: DriveSyncPreview = {id: crypto.randomUUID(), account: session.account, hasRemote: Boolean(remote), includeSensitive, remoteIncludesSensitive, hasBaseline: Boolean(baseline), ...(remote?.file.readOnly ? {canUpload: false as const} : {}), changes: diff?.changes ?? [], expiresAt: ports.now() + 10 * 60_000};
        pending = {preview, local, originalLocal, remote, remoteConfig, diff, proof: await proof(preview.id, passphrase)};
        // MV3 休眠后的授权范围同时保存在密文与事务元数据中；完整原始本机快照供检测与回滚。
        const content = await encryptDrivePreview({preview: {...preview, changes: []}, local: originalLocal, proof: pending.proof}, passphrase);
        await ports.writeState({...state, connected: true, accountId: session.account.id, prepared: {id: preview.id, expiresAt: preview.expiresAt, content, tabId, clientId, format: 2, scope: includeSensitive ? 'complete' : 'settings', remote}});
        return preview;
    }
    async function commit(id: string, passphrase: string, direction: DriveSyncDirection, choices: Record<string, unknown>): Promise<DriveSyncStatus> {
        validateDrivePassphrase(passphrase);
        const state = readState(await ports.readState());
        if (!state.prepared || state.prepared.id !== id || state.prepared.expiresAt <= ports.now()) throw new CloudSyncError('同步预览已失效，请重新生成。');
        // 旧 worker 的待确认事务没有明确的本次范围，绝不能默认解释为允许上传秘密。
        if (state.prepared.scope !== 'settings' && state.prepared.scope !== 'complete') throw new CloudSyncError('同步预览缺少敏感信息范围，请重新生成。');
        if (!pending) {
            const restored = await decryptDrivePreview(state.prepared.content, passphrase) as {preview: DriveSyncPreview; local: DriveSyncConfig; proof: string};
            if (!restored.preview || typeof restored.preview.includeSensitive !== 'boolean'
                || typeof restored.preview.remoteIncludesSensitive !== 'boolean'
                || !restored.local || typeof restored.local !== 'object' || Array.isArray(restored.local)) throw new CloudSyncError('同步预览缺少敏感信息范围，请重新生成。');
            const local = parseDriveSyncPayload(driveSyncPayload(restored.local, true));
            const remote = state.prepared.remote ?? null;
            const snapshot = remote ? parseDriveSyncSnapshot(await decryptDriveConfig(remote.content, passphrase)) : null;
            if ((snapshot?.includesSensitive ?? false) !== restored.preview.remoteIncludesSensitive) throw new CloudSyncError('同步预览范围已变化，请重新生成。');
            const sensitiveDiff = restored.preview.includeSensitive && restored.preview.remoteIncludesSensitive;
            const remoteConfig = snapshot ? projectDriveSyncConfig(snapshot.config, sensitiveDiff) : null;
            const baseline = restored.preview.hasBaseline ? projectDriveSyncConfig(parseDriveSyncPayload(await decryptDriveConfig(state.baseline, passphrase)), sensitiveDiff) : null;
            pending = {...restored, originalLocal: restored.local, local, remote, remoteConfig, diff: remoteConfig ? buildDriveSyncDiff(baseline, projectDriveSyncConfig(local, sensitiveDiff), remoteConfig) : null};
        }
        if (pending.preview.includeSensitive !== (state.prepared.scope === 'complete')) throw new CloudSyncError('同步预览范围已变化，请重新生成。');
        const current = pending;
        pending = null; // 一次性确认；任何失败都要求重新预览。
        delete state.prepared;
        await ports.writeState(state);
        if (!current || current.preview.id !== id || current.preview.expiresAt <= ports.now()) throw new CloudSyncError('同步预览已失效，请重新生成。');
        if (await proof(id, passphrase) !== current.proof) throw new CloudSyncError('同步口令已修改，请重新生成预览。');
        if (!state.connected) throw new CloudSyncError('本次同步授权已结束，请重新生成预览。');
        const session = await ports.auth.open(false);
        if (session.account.id !== current.preview.account.id) throw new CloudSyncError(ports.accountChangedError ?? '同步连接已变化，请重新生成预览。');
        if (!driveValuesEqual(await ports.snapshot(), current.originalLocal)) throw new CloudSyncError('本机配置已变化，请重新生成同步预览。');
        const sensitiveDiff = current.preview.includeSensitive && current.preview.remoteIncludesSensitive;
        let next: DriveSyncConfig;
        if (direction === 'upload') next = current.local;
        else if (direction === 'download' && current.remoteConfig) next = sensitiveDiff ? current.remoteConfig : restoreDriveSyncSettings(current.local, current.remoteConfig);
        else if (direction === 'merge' && current.diff) {
            const merged = resolveDriveSyncDiff(current.diff, choices);
            next = sensitiveDiff ? merged : restoreDriveSyncSettings(current.local, merged);
        }
        else throw new CloudSyncError('无效的同步方向，请重新选择。');
        // 必须在任何云端写入之前验证完整配置及服务引用；不能依赖 apply 才发现无效合并。
        next = parseDriveSyncPayload(driveSyncPayload(next, true));
        const cloudConfig = projectDriveSyncConfig(next, current.preview.includeSensitive);
        const remoteChanged = !current.remoteConfig || current.preview.includeSensitive !== current.preview.remoteIncludesSensitive
            || !driveValuesEqual(cloudConfig, current.remoteConfig);
        const content = direction === 'download' || !remoteChanged ? current.remote!.content : await encryptDriveConfig(driveSyncPayload(next, current.preview.includeSensitive), passphrase);
        if (!sameRemote(await ports.api.read(session), current.remote)) throw new CloudSyncError('云端配置已变化，请重新生成同步预览。');
        if (direction !== 'download' && remoteChanged) {
            if (current.remote?.file.readOnly) throw new CloudSyncError('云端备份缺少安全覆盖所需的版本信息；仍可恢复，请重新读取后重试。');
            await ports.api.write(session, content, current.remote?.file ?? null);
        }
        const localChanged = !driveValuesEqual(next, current.local);
        if (localChanged) {
            try {await ports.apply(next);} catch {
                try {await ports.apply(current.originalLocal);} catch {throw new CloudSyncError('本机保存和恢复失败，请重新打开设置检查配置；云端保留本次加密快照。');}
                throw new CloudSyncError('本机保存失败，已恢复原配置；请重新预览后重试。');
            }
        }
        await ports.writeState({version: 1, connected: false, accountId: session.account.id, baseline: content, lastSyncedAt: ports.now(), lastSyncedAccount: session.account});
        return {...ports.auth.availability(), account: session.account, lastSyncedAt: ports.now()};
    }
    return {
        status: () => exclusive(status),
        prepare: (passphrase: string, tabId?: number, clientId?: string, includeSensitive = false) => exclusive(async () => {
            const state = readState(await ports.readState());
            if (state.prepared && state.prepared.expiresAt > ports.now() && !owns(state, tabId, clientId)) {
                throw new CloudSyncError('另一个设置页面正在确认同步，请先完成或取消该页面的预览。');
            }
            try {return await prepare(passphrase, tabId, clientId, includeSensitive);} catch (error) {await finishSession().catch(() => undefined); throw error;}
        }),
        commit: (id: string, passphrase: string, direction: DriveSyncDirection, choices: Record<string, unknown>, tabId?: number, clientId?: string) => exclusive(async () => {
            const state = readState(await ports.readState());
            // 不属于调用方的错误确认不能清理其他页面的事务或令牌。
            if (state.prepared && (!owns(state, tabId, clientId) || state.prepared.id !== id)) {
                throw new CloudSyncError('同步预览属于其他页面或已失效，请在原设置页面继续。');
            }
            let result: DriveSyncStatus;
            try {result = await commit(id, passphrase, direction, choices);}
            catch (error) {await finishSession().catch(() => undefined); throw error;}
            try {await finishSession();} catch {return {...result, cleanupPending: true};}
            return result;
        }),
        cancel: (id?: string, tabId?: number, clientId?: string) => exclusive(async () => {
            if (id === undefined && tabId === undefined && clientId === undefined) return finishSession();
            const state = readState(await ports.readState());
            if (state.prepared && (!owns(state, tabId, clientId) || (id !== undefined && state.prepared.id !== id))) return;
            // 没有预览时，UI 的取消不触碰另一页仍在授权的缓存；内部调用仍可清理旧状态。
            if (!state.prepared && clientId !== undefined) return;
            await finishSession();
        }),
        cancelTab: (tabId: number) => exclusive(async () => {
            const state = readState(await ports.readState());
            if (state.prepared?.tabId === tabId) await finishSession();
        }),
    };
}

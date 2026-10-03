/**
 * @file src/services/config/remoteConfigSync.ts
 * 文件职责：编排 Google Drive 与 WebDAV 共用的完整配置云备份和用户确认事务。
 * 主要内容：单次授权、账号绑定、上次成功同步的账号记录、密文基线、三方合并、
 * 掩码预览、过期检查与自动清理授权缓存；换号失败不改动成功记录。
 * 模块边界：通过端口读写配置与云端存储；不持久化口令，不向设置页面传递完整配置。
 */
import {buildDriveSyncDiff, driveSyncPayload, driveValuesEqual, parseDriveSyncPayload, resolveDriveSyncDiff, toDriveSyncConfig, type DriveSyncConfig, type DriveSyncDiff} from '@/src/core/config/driveSync';
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
    prepared?: {id: string; expiresAt: number; content: string; tabId?: number; clientId?: string; format?: 2; remote?: DriveRemote | null};
}
export interface DriveSyncStatus {available: boolean; reason: string; account: DriveAccount | null; lastSyncedAt: number | null}
export interface DriveSyncPreview {
    id: string;
    account: DriveAccount;
    hasRemote: boolean;
    hasBaseline: boolean;
    changes: DriveSyncDiff['changes'];
    expiresAt: number;
}
export type DriveSyncDirection = 'upload' | 'download' | 'merge';
export interface DriveSyncPorts<Session extends DriveSession = DriveSession> {
    auth: {availability(): {available: boolean; reason: string}; open(interactive?: boolean, selectAccount?: boolean): Promise<Session>; disconnect(): Promise<void>};
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
        try {
            const state = readState(await ports.readState());
            delete state.prepared;
            await ports.writeState({...state, connected: false});
        } finally {await ports.auth.disconnect();}
    }
    async function status(): Promise<DriveSyncStatus> {
        const availability = ports.auth.availability();
        const state = readState(await ports.readState());
        // 打开设置不获取令牌；顺便清理旧实现留下的连接或已经过期的事务。
        if (state.connected && (!state.prepared || state.prepared.expiresAt <= ports.now())) await finishSession();
        return {...availability, account: state.lastSyncedAccount ?? null, lastSyncedAt: state.lastSyncedAt};
    }
    async function prepare(passphrase: string, tabId?: number, clientId?: string, selectAccount = false): Promise<DriveSyncPreview> {
        validateDrivePassphrase(passphrase);
        pending = null;
        const session = await (selectAccount ? ports.auth.open(true, true) : ports.auth.open(true));
        const previous = readState(await ports.readState());
        // 换账号只重置合并基线；取消或授权失败时仍能看到上次成功同步的账号及时间。
        const state = previous.accountId === session.account.id ? previous : {...emptyState(), lastSyncedAt: previous.lastSyncedAt, ...(previous.lastSyncedAccount ? {lastSyncedAccount: previous.lastSyncedAccount} : {})};
        delete state.prepared;
        const local = toDriveSyncConfig(await ports.snapshot());
        const remote = await ports.api.read(session);
        const remoteConfig = remote ? parseDriveSyncPayload(await decryptDriveConfig(remote.content, passphrase)) : null;
        let baseline: DriveSyncConfig | null = null;
        if (remote && state.accountId === session.account.id && state.baseline) {
            // 云端在其他设备重新加密后，旧基线不再可信，回到明确选择方向的首次同步流程。
            try {baseline = parseDriveSyncPayload(await decryptDriveConfig(state.baseline, passphrase));} catch {baseline = null;}
        }
        const diff = remoteConfig ? buildDriveSyncDiff(baseline, local, remoteConfig) : null;
        const preview: DriveSyncPreview = {id: crypto.randomUUID(), account: session.account, hasRemote: Boolean(remote), hasBaseline: Boolean(baseline), changes: diff?.changes ?? [], expiresAt: ports.now() + 10 * 60_000};
        pending = {preview, local, remote, remoteConfig, diff, proof: await proof(preview.id, passphrase)};
        // MV3 worker 可能在用户阅读预览时休眠；待确认快照仅以口令密文保存。
        // 本机快照只封装一次；云端已经是密文，基线已经存在状态中，避免再次加密放大三倍。
        const content = await encryptDrivePreview({preview: {...preview, changes: []}, local, proof: pending.proof}, passphrase);
        await ports.writeState({...state, connected: true, accountId: session.account.id, prepared: {id: preview.id, expiresAt: preview.expiresAt, content, tabId, clientId, format: 2, remote}});
        return preview;
    }
    async function commit(id: string, passphrase: string, direction: DriveSyncDirection, choices: Record<string, unknown>): Promise<DriveSyncStatus> {
        validateDrivePassphrase(passphrase);
        const state = readState(await ports.readState());
        if (!state.prepared || state.prepared.id !== id || state.prepared.expiresAt <= ports.now()) throw new CloudSyncError('同步预览已失效，请重新生成。');
        if (!pending) {
            const restored = await decryptDrivePreview(state.prepared.content, passphrase) as {preview: DriveSyncPreview; local: DriveSyncConfig; remote: DriveRemote | null; baseline: string; proof: string};
            if (state.prepared.format === 2) {
                restored.remote = state.prepared.remote ?? null;
                restored.baseline = restored.preview.hasBaseline ? state.baseline : '';
            }
            const local = parseDriveSyncPayload(driveSyncPayload(restored.local));
            const remoteConfig = restored.remote ? parseDriveSyncPayload(await decryptDriveConfig(restored.remote.content, passphrase)) : null;
            const baseline = restored.baseline ? parseDriveSyncPayload(await decryptDriveConfig(restored.baseline, passphrase)) : null;
            pending = {...restored, local, remoteConfig, diff: remoteConfig ? buildDriveSyncDiff(baseline, local, remoteConfig) : null};
        }
        const current = pending;
        pending = null; // 一次性确认；任何失败都要求重新预览。
        delete state.prepared;
        await ports.writeState(state);
        if (!current || current.preview.id !== id || current.preview.expiresAt <= ports.now()) throw new CloudSyncError('同步预览已失效，请重新生成。');
        if (await proof(id, passphrase) !== current.proof) throw new CloudSyncError('同步口令已修改，请重新生成预览。');
        if (!state.connected) throw new CloudSyncError('本次同步授权已结束，请重新生成预览。');
        const session = await ports.auth.open(false);
        if (session.account.id !== current.preview.account.id) throw new CloudSyncError(ports.accountChangedError ?? '同步连接已变化，请重新生成预览。');
        if (!driveValuesEqual(toDriveSyncConfig(await ports.snapshot()), current.local)) throw new CloudSyncError('本机配置已变化，请重新生成同步预览。');
        let next: DriveSyncConfig;
        if (direction === 'upload') next = current.local;
        else if (direction === 'download' && current.remoteConfig) next = current.remoteConfig;
        else if (direction === 'merge' && current.diff) next = resolveDriveSyncDiff(current.diff, choices);
        else throw new CloudSyncError('无效的同步方向，请重新选择。');
        // 必须在任何云端写入之前验证完整配置及服务引用；不能依赖 apply 才发现无效合并。
        next = parseDriveSyncPayload(driveSyncPayload(next));
        const content = direction === 'download' ? current.remote!.content : await encryptDriveConfig(driveSyncPayload(next), passphrase);
        if (!sameRemote(await ports.api.read(session), current.remote)) throw new CloudSyncError('云端配置已变化，请重新生成同步预览。');
        if (direction !== 'download') await ports.api.write(session, content, current.remote?.file ?? null);
        const localChanged = !driveValuesEqual(next, current.local);
        if (localChanged) {
            try {await ports.apply(next);} catch {
                try {await ports.apply(current.local);} catch {throw new CloudSyncError('本机保存和恢复失败，请重新打开设置检查配置；云端保留本次加密快照。');}
                throw new CloudSyncError('本机保存失败，已恢复原配置；请重新预览后重试。');
            }
        }
        await ports.writeState({version: 1, connected: false, accountId: session.account.id, baseline: content, lastSyncedAt: ports.now(), lastSyncedAccount: session.account});
        return {...ports.auth.availability(), account: session.account, lastSyncedAt: ports.now()};
    }
    return {
        status: () => exclusive(status),
        prepare: (passphrase: string, tabId?: number, clientId?: string, selectAccount = false) => exclusive(async () => {
            const state = readState(await ports.readState());
            if (state.prepared && state.prepared.expiresAt > ports.now() && !owns(state, tabId, clientId)) {
                throw new CloudSyncError('另一个设置页面正在确认同步，请先完成或取消该页面的预览。');
            }
            try {return await prepare(passphrase, tabId, clientId, selectAccount);} catch (error) {await finishSession(); throw error;}
        }),
        commit: (id: string, passphrase: string, direction: DriveSyncDirection, choices: Record<string, unknown>, tabId?: number, clientId?: string) => exclusive(async () => {
            const state = readState(await ports.readState());
            // 不属于调用方的错误确认不能清理其他页面的事务或令牌。
            if (state.prepared && (!owns(state, tabId, clientId) || state.prepared.id !== id)) {
                throw new CloudSyncError('同步预览属于其他页面或已失效，请在原设置页面继续。');
            }
            try {return await commit(id, passphrase, direction, choices);} finally {await finishSession();}
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

/**
 * @file src/services/config/webDavBackup.ts
 * 文件职责：编排 WebDAV 连接管理与共用配置云备份事务。
 * 主要内容：只读连接测试、带修订号的保存与清除、预览页面所有权、后台重启恢复；
 * 连接密码单独保存在本机，切换服务器或账号会使旧预览和共同基线失效。
 * 模块边界：通过端口调用 WebDAV 和配置仓库，不直接访问浏览器，不向 UI 返回密码。
 */
import {CloudSyncError} from '@/src/core/config/cloudSync';
import {createRemoteConfigSync, type DriveSyncPorts, type DriveSyncState} from './remoteConfigSync';
import {createWebDavSession, parseWebDavConnection, webDavConnectionSummary, WebDavError, type WebDavConnectionInput, type WebDavSession, type createWebDavConnectionStore} from '@/src/platform/webdav/connection';
import type {createWebDavApi} from '@/src/platform/webdav/api';

export interface WebDavBackupPorts extends Omit<DriveSyncPorts<WebDavSession>, 'auth' | 'api'> {
    connections: ReturnType<typeof createWebDavConnectionStore>;
    api: ReturnType<typeof createWebDavApi>;
    removeState(): Promise<void>;
}
export function createWebDavBackup(ports: WebDavBackupPorts) {
    const availability = () => ({available: true, reason: ''});
    const sync = createRemoteConfigSync({...ports, auth: {
        availability,
        async open(interactive = false) {
            const connection = await ports.connections.read();
            if (!connection) throw new WebDavError('missing');
            if (interactive) await ports.api.test(connection);
            return createWebDavSession(connection, ports.connections.read);
        },
        async disconnect() {},
    }});
    let queue: Promise<unknown> = Promise.resolve();
    function exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    }
    async function assertOwner(tabId?: number, clientId?: string) {
        const state = await ports.readState() as DriveSyncState | null;
        if (state?.prepared && state.prepared.expiresAt > ports.now() && (state.prepared.tabId !== tabId || state.prepared.clientId !== clientId)) throw new CloudSyncError('另一个设置页面正在确认同步，请先完成或取消该页面的预览。');
    }
    async function candidate(input: WebDavConnectionInput) {
        const previous = await ports.connections.read();
        const next = parseWebDavConnection(input, previous);
        if (previous && next.url === previous.url && next.username === previous.username && next.password === previous.password && next.allowInsecure === previous.allowInsecure) next.revision = previous.revision;
        return next;
    }
    return {
        status: () => exclusive(async () => {
            const status = await sync.status();
            const connection = await ports.connections.read();
            return {...status, ...(!connection ? {available: false, reason: '请先设置 WebDAV 服务器和应用密码。'} : {})};
        }),
        settings: () => exclusive(async () => webDavConnectionSummary(await ports.connections.read())),
        test: (input: WebDavConnectionInput) => exclusive(async () => ports.api.test(await candidate(input))),
        save: (input: WebDavConnectionInput, tabId?: number, clientId?: string) => exclusive(async () => {
            await assertOwner(tabId, clientId);
            const next = await candidate(input);
            await ports.api.test(next);
            await sync.cancel(undefined, tabId, clientId);
            await ports.connections.write(next);
            return webDavConnectionSummary(next)!;
        }),
        clear: (revision: unknown, tabId?: number, clientId?: string) => exclusive(async () => {
            await assertOwner(tabId, clientId);
            const current = await ports.connections.read();
            if (revision !== (current?.revision ?? null)) throw new WebDavError('changed');
            await sync.cancel(undefined, tabId, clientId);
            await ports.connections.remove();
            await ports.removeState();
        }),
        prepare: (...args: Parameters<typeof sync.prepare>) => exclusive(() => sync.prepare(...args)),
        commit: (...args: Parameters<typeof sync.commit>) => exclusive(() => sync.commit(...args)),
        cancel: (...args: Parameters<typeof sync.cancel>) => exclusive(() => sync.cancel(...args)),
        cancelTab: (...args: Parameters<typeof sync.cancelTab>) => exclusive(() => sync.cancelTab(...args)),
    };
}

/**
 * @file src/platform/browser/freeProviderPermissions.ts
 * 文件职责：封装 Safari 免费翻译服务的精确域授权查询与用户手势授权入口。
 * 主要内容：维护当前十六个匿名 provider 的完整请求域集合并过滤旧配置中的已退役节点；仅 Safari 按实际授权过滤可用服务，查询受取消信号、原截止时间与两秒上限约束，失败明确拒绝；授权函数同步调用浏览器 API，保留点击手势，成功结果仍须重新查询实际授权；为界面提供可清理的授权变更事件。
 * 模块边界：这是 Safari 免费池的产品授权策略，不声称开放 CORS 接口技术上都需要授权；不请求所有站点、不发送供应商请求、不修改服务顺序、健康或持久配置，其他浏览器保持原行为。
 */
import {isFreeTranslationProviderId, type FreeTranslationProviderId} from '@/src/core/config/freeTranslation';
import {FREE_PROVIDER_ORIGINS} from '@/src/core/config/freeProviderOrigins';

export const FREE_PROVIDER_PERMISSION_QUERY_TIMEOUT_MS = 2_000;

export interface FreePoolAccess {
    readonly supported: boolean;
    readonly grantedIds: readonly FreeTranslationProviderId[];
    readonly preferredGrant: {readonly id: FreeTranslationProviderId; readonly origins: readonly string[]} | null;
}

export interface FreePoolAccessOptions {
    readonly signal?: AbortSignal;
    /** 调用方既有的绝对截止时间；不会因查询或重试重新起算。 */
    readonly deadline?: number;
}

function permissionError(unavailable: boolean): Error {
    return Object.assign(new Error(unavailable
        ? '无法确认 Safari 翻译服务的访问权限，请重新打开扩展后重试。'
        : 'Safari 免费翻译仅使用已授权的服务。请在扩展弹出窗口或免费翻译设置中允许一个翻译服务。'), {
        code: unavailable ? 'SAFARI_FREE_PROVIDER_PERMISSION_UNAVAILABLE' : 'SAFARI_FREE_PROVIDER_PERMISSION_REQUIRED',
        kind: 'bad-request',
        retryable: false,
    });
}

/** 每个新请求重新读取实际授权，不把一天权限或配置启用状态缓存为永久授权。 */
export async function readFreePoolAccess(order: readonly string[], options: FreePoolAccessOptions = {}): Promise<FreePoolAccess> {
    const ids = [...new Set(order.filter(isFreeTranslationProviderId))];
    if (import.meta.env.BROWSER !== 'safari') return {supported: false, grantedIds: ids, preferredGrant: null};
    if (options.signal?.aborted) throw options.signal.reason;
    const remainingMs = Math.min(FREE_PROVIDER_PERMISSION_QUERY_TIMEOUT_MS,
        options.deadline === undefined ? FREE_PROVIDER_PERMISSION_QUERY_TIMEOUT_MS : options.deadline - Date.now());
    if (!(remainingMs > 0)) throw permissionError(true);
    if (typeof browser === 'undefined' || typeof browser.permissions?.contains !== 'function') throw permissionError(true);
    const allowed = await new Promise<boolean[]>((resolve, reject) => {
        let settled = false;
        const finish = (success: boolean, value: unknown) => {
            // 浏览器权限查询自身不可取消；消费晚结果，但不再让它改变已结束的调用。
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            if (success) resolve(value as boolean[]); else reject(value);
        };
        const onAbort = () => finish(false, options.signal!.reason);
        const timer = setTimeout(() => finish(false, permissionError(true)), remainingMs);
        options.signal?.addEventListener('abort', onAbort, {once: true});
        // 每项同步异常也转换为 promise，避免 map 中途抛出后遗留前项未消费的拒绝。
        const queries = ids.map(id => {
            try {return browser.permissions.contains({origins: [...FREE_PROVIDER_ORIGINS[id]]});}
            catch {return Promise.reject(permissionError(true));}
        });
        void Promise.all(queries).then(result => finish(true, result), () => finish(false, permissionError(true)));
    });
    const grantedIds = ids.filter((_id, index) => allowed[index] === true);
    const missing = ids.find(id => !grantedIds.includes(id));
    return {supported: true, grantedIds, preferredGrant: missing ? {id: missing, origins: FREE_PROVIDER_ORIGINS[missing]} : null};
}

/** 必须直接从扩展页面的点击回调调用；本函数不可改为 async 或先查询权限。 */
export function requestFreeProviderAccess(id: FreeTranslationProviderId): Promise<boolean> {
    if (!isFreeTranslationProviderId(id)) throw new TypeError('无效的免费翻译服务');
    if (import.meta.env.BROWSER !== 'safari') return Promise.resolve(true);
    if (typeof browser === 'undefined' || typeof browser.permissions?.request !== 'function') throw permissionError(true);
    return browser.permissions.request({origins: [...FREE_PROVIDER_ORIGINS[id]]});
}

/** 调度层只过滤临时集合，不改动用户选择或把未授权记为供应商失败。 */
export function isFreeProviderAllowed(access: FreePoolAccess, id: FreeTranslationProviderId): boolean {
    return !access.supported || access.grantedIds.includes(id);
}

/** 无候选或单服务检查未授权时，在进入免费池尝试及健康记录之前拒绝。 */
export function requireFreeProviderAccess(access: FreePoolAccess, id?: FreeTranslationProviderId): void {
    if (access.supported && (id ? !isFreeProviderAllowed(access, id) : access.grantedIds.length === 0)) throw permissionError(false);
}

/** 只监听实际域权限变化；刷新不得申请授权，界面负责保留同次点击的继续操作。 */
export function subscribeFreeProviderAccessChanges(listener: (change: 'added' | 'removed') => void): () => void {
    if (import.meta.env.BROWSER !== 'safari' || typeof browser === 'undefined') return () => undefined;
    let active = true;
    const cleanup: Array<() => void> = [];
    for (const [name, change] of [['onAdded', 'added'], ['onRemoved', 'removed']] as const) {
        const event = browser.permissions?.[name];
        if (typeof event?.addListener !== 'function' || typeof event.removeListener !== 'function') continue;
        const handle = (details: {origins?: string[]}) => {
            if (active && details.origins?.length) listener(change);
        };
        try {
            event.addListener(handle);
            cleanup.push(() => event.removeListener(handle));
        } catch { /* 部分浏览器不提供事件；界面重新激活时仍会复查实际授权。 */ }
    }
    return () => {
        active = false;
        for (const remove of cleanup) {
            try {remove();} catch { /* 关闭中的扩展上下文可能已失效。 */ }
        }
    };
}

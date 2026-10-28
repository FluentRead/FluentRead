/** Trusted, bounded setup for the material summary read transport. */
import type {MaterialRepository} from './materialRepository';
import {streamMaterialSummaries, type MaterialSummaryQuery} from './materialReadSource';
import {MATERIAL_READ_PORT_NAME, sendMaterialRead, type MaterialReadPort} from './materialReadTransport';

export type MaterialReadSender = {id?:string; url?:string; incognito?:boolean; tab?:{id?:number; incognito?:boolean}};
export type MaterialReadBridgePort = MaterialReadPort & {name:string; sender?:MaterialReadSender};
type Repository = Pick<MaterialRepository, 'openSnapshot' | 'readSnapshotRecord' | 'checkSnapshot'>;
export interface MaterialReadBridgeOptions {
    repository: Repository;
    ready: Promise<unknown>;
    /** Composition root must verify the extension ID and exact settings URL. */
    isTrustedSender(sender:MaterialReadSender | undefined):boolean;
    isPrivateContext(): boolean;
    maxPorts?: number;
    idleTimeoutMs?: number;
}
const MAX_SEARCH_LENGTH = 128 * 1024;

function parseStart(message: unknown): MaterialSummaryQuery {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('invalid request');
    const request = message as Record<string, unknown>;
    const keys = Object.keys(request);
    if (keys.length !== 4 || !['v','type','operation','options'].every(key => Object.hasOwn(request,key))
        || request.v !== 1 || request.type !== 'start' || request.operation !== 'summaries'
        || !request.options || typeof request.options !== 'object' || Array.isArray(request.options)) throw Error('invalid request');
    const value = request.options as Record<string, unknown>;
    if (Object.keys(value).some(key => !['archived','topic','search'].includes(key))
        || (value.archived !== undefined && typeof value.archived !== 'boolean')
        || (value.topic !== undefined && (typeof value.topic !== 'string' || value.topic.length > 80))
        || (value.search !== undefined && (typeof value.search !== 'string' || value.search.length > MAX_SEARCH_LENGTH))) throw Error('invalid request');
    return {archived: value.archived as boolean | undefined, topic: value.topic as string | undefined, search: value.search as string | undefined};
}

/** The caller must install the receiver before sending start. No source data is
 * read before that explicit handshake and the injected readiness gate. */
export function createMaterialReadBridge(options: MaterialReadBridgeOptions): {connect(port:MaterialReadBridgePort):boolean; dispose():void} {
    const maxPorts = options.maxPorts ?? 2, timeout = options.idleTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(maxPorts) || maxPorts < 1 || maxPorts > 32
        || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw Error('invalid bridge limits');
    let disposed = false, ready: 'pending'|'ready'|'failed' = 'pending';
    const readyWaiters = new Set<(ok:boolean)=>void>();
    void options.ready.then(() => {ready = 'ready'; for (const waiter of [...readyWaiters]) waiter(true);},
        () => {ready = 'failed'; for (const waiter of [...readyWaiters]) waiter(false);});
    const active = new Set<() => void>(), claimed = new WeakSet<MaterialReadBridgePort>();
    function waitReady(signal:AbortSignal):Promise<void> {
        if (signal.aborted || disposed) return Promise.reject(Error('unavailable'));
        if (ready !== 'pending') return ready === 'ready' ? Promise.resolve() : Promise.reject(Error('unavailable'));
        return new Promise((resolve, reject) => {
            const finish = (ok:boolean) => {readyWaiters.delete(finish); signal.removeEventListener('abort', abort); ok ? resolve() : reject(Error('unavailable'));};
            const abort = () => finish(false);
            readyWaiters.add(finish); signal.addEventListener('abort', abort, {once:true});
            if (signal.aborted) abort();
        });
    }
    function connect(port:MaterialReadBridgePort):boolean {
        if (port.name !== MATERIAL_READ_PORT_NAME) return false;
        if (claimed.has(port)) return true;
        claimed.add(port);
        let trusted = false;
        try {trusted = !disposed && !options.isPrivateContext() && port.sender?.incognito !== true && port.sender?.tab?.incognito !== true
            && options.isTrustedSender(port.sender);} catch {/* Fail closed. */}
        if (!trusted || active.size >= maxPorts) {try {port.disconnect();} catch {} return true;}
        const controller = new AbortController();
        const pending = new Set<Promise<unknown>>();
        let started = false, closed = false;
        const timer = setTimeout(() => close(), timeout);
        const cleanup = () => {
            clearTimeout(timer);
            try {port.onMessage.removeListener(onMessage);} catch {}
            try {port.onDisconnect.removeListener(onDisconnect);} catch {}
        };
        const close = () => {
            if (closed) return;
            closed = true; controller.abort(); cleanup();
            try {port.disconnect();} catch {}
            if (!started) active.delete(close);
        };
        const onDisconnect = () => close();
        const track = <T>(work:Promise<T>):Promise<T> => {
            pending.add(work);
            void work.then(() => pending.delete(work), () => pending.delete(work));
            return work;
        };
        const onMessage = (message:unknown) => {
            if (started) {close(); return;}
            let query:MaterialSummaryQuery;
            try {query = parseStart(message);} catch {close(); return;}
            started = true;
            void (async () => {
                try {
                    await waitReady(controller.signal);
                    if (controller.signal.aborted || disposed || options.isPrivateContext()) throw Error('unavailable');
                    // Remove handshake listeners immediately before the transport installs its own.
                    clearTimeout(timer); port.onMessage.removeListener(onMessage); port.onDisconnect.removeListener(onDisconnect);
                    await sendMaterialRead(port, signal => {
                        const iterator = streamMaterialSummaries(options.repository, query, signal);
                        return {[Symbol.asyncIterator]() {return {
                            next: () => track(iterator.next()),
                            return: () => track(iterator.return(undefined)),
                        };}};
                    }, {signal:controller.signal, idleTimeoutMs:timeout});
                } catch {/* Disconnect without forwarding private storage or source errors. */}
                finally {
                    close();
                    // The transport may stop waiting before an underlying read settles.
                    // Keep the capacity lease until that actual work and iterator cleanup finish.
                    while (pending.size) await Promise.allSettled([...pending]);
                    active.delete(close);
                }
            })();
        };
        active.add(close);
        try {port.onDisconnect.addListener(onDisconnect); if (!closed) port.onMessage.addListener(onMessage); if (closed) cleanup();}
        catch {close();}
        return true;
    }
    return {connect, dispose() {if (disposed) return; disposed = true; for (const close of [...active]) close();}};
}

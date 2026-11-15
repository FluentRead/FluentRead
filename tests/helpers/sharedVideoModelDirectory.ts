import {vi} from 'vitest';

/** File System Access 与 IndexedDB 的边界夹具；模型缓存和校验仍执行生产模块。 */
export function sharedDirectoryFixture() {
    const files = new Map<string, Uint8Array>();
    const removed: string[] = [];
    let stored: unknown;
    let read: string = 'granted', write: string = 'granted';
    let operationError: Error | undefined;
    const faults: {
        idb?: {phase: string; error?: Error}; metadataWrite?: boolean; bodyWrite?: boolean;
        read?: boolean; remove?: boolean; onRead?: (key: string) => void;
    } = {};
    const directory = (prefix = ''): any => ({
        kind: 'directory', name: prefix || 'shared',
        queryPermission: vi.fn(async ({mode}: {mode: string}) => mode === 'read' ? read : write),
        getDirectoryHandle: vi.fn(async (name: string) => {
            if (operationError) throw operationError;
            return directory(`${prefix}${name}/`);
        }),
        getFileHandle: vi.fn(async (name: string, options?: {create?: boolean}) => {
            const key = prefix + name;
            if (!files.has(key) && !options?.create) throw new DOMException('missing file', 'NotFoundError');
            return {
                getFile: async () => {
                    faults.onRead?.(key);
                    const file = new File([new Uint8Array(files.get(key) || [])], name);
                    if (faults.read) Object.defineProperty(file, 'stream', {value: () => new ReadableStream({start: controller => controller.error(new Error('read disconnected'))})});
                    return file;
                },
                createWritable: async () => {
                    const chunks: Uint8Array[] = [];
                    return {
                        write: async (value: string | Uint8Array) => {
                            if (faults.metadataWrite && name.endsWith('.fluentread.json') || faults.bodyWrite && !name.endsWith('.fluentread.json')) throw new Error('write disconnected');
                            chunks.push(typeof value === 'string' ? new TextEncoder().encode(value) : value.slice());
                        },
                        close: async () => {
                            const data = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
                            let at = 0;
                            for (const chunk of chunks) {data.set(chunk, at); at += chunk.length;}
                            files.set(key, data);
                        },
                        abort: vi.fn(async () => {throw new Error('abort disconnected');}),
                    };
                },
            };
        }),
        removeEntry: vi.fn(async (name: string) => {
            if (faults.remove) throw new Error('remove disconnected');
            removed.push(prefix + name); files.delete(prefix + name);
        }),
    });
    const handle = directory();
    const database = {
        objectStoreNames: {contains: () => false}, createObjectStore: vi.fn(), close: vi.fn(),
        transaction: vi.fn(() => {
            const transaction: any = {};
            const request = (value: unknown) => {
                const result: any = {result: value};
                queueMicrotask(() => {
                    if (faults.idb?.phase === 'request') {
                        result.error = faults.idb.error; result.onerror?.(); transaction.oncomplete?.();
                    } else if (faults.idb?.phase === 'transaction' || faults.idb?.phase === 'abort') {
                        transaction.error = faults.idb.error; result.onsuccess?.();
                        if (faults.idb.phase === 'abort') transaction.onabort?.(); else transaction.onerror?.();
                    } else {result.onsuccess?.(); transaction.oncomplete?.();}
                });
                return result;
            };
            transaction.objectStore = () => ({
                get: () => request(stored),
                put: (value: unknown) => {stored = value; return request(undefined);},
                delete: () => {stored = undefined; return request(undefined);},
            });
            return transaction;
        }),
    };
    const indexedDB = {open: vi.fn(() => {
        const request: any = {result: database};
        queueMicrotask(() => {
            if (faults.idb?.phase === 'open') {request.error = faults.idb.error; request.onerror?.();}
            else {request.onupgradeneeded?.(); request.onsuccess?.();}
        });
        return request;
    })};
    const picker = vi.fn(async () => handle);
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('window', {showDirectoryPicker: picker});
    return {
        files, removed, handle, database, indexedDB, picker, faults,
        setStored: (value: unknown) => {stored = value;},
        permissions: (r: string, w: string) => {read = r; write = w;},
        failFiles: (error?: Error) => {operationError = error;},
    };
}

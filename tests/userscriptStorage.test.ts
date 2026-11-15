import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    completeUserscriptConfigPreparation,
    configStorage,
    getStoredValue,
    listStoredKeys,
    removeStoredValue,
    setStoredValue,
    storage,
} from '@/userscript/storage';

describe('userscript GM storage adapter', () => {
    it.each(['classic', 'modern', 'memory'] as const)('preserves stored null while applying an undecoded default only to missing keys (%s)', async kind => {
        const values = new Map<string, unknown>();
        const getValue = (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback;
        const setValue = (key: string, value: unknown) => {values.set(key, value);};
        if (kind === 'classic') {globalThis.GM_getValue = getValue as NonNullable<typeof globalThis.GM_getValue>;globalThis.GM_setValue = setValue;}
        if (kind === 'modern') globalThis.GM = {getValue, setValue};
        const key = `local:default-contract-${kind}`;
        await setStoredValue(key, null);
        expect(await getStoredValue(key, {fallback: 'fallback'})).toBeNull();
        expect(await getStoredValue(`${key}-absent`, {fallback: 'null'})).toBe('null');
        expect(await getStoredValue(`${key}-absent`, {fallback: undefined})).toBeUndefined();
        expect(await getStoredValue(`${key}-absent`)).toBeNull();
        await removeStoredValue(key);
    });

    afterEach(() => {
        globalThis.GM_getValue = undefined;
        globalThis.GM_setValue = undefined;
        globalThis.GM_deleteValue = undefined;
        globalThis.GM_listValues = undefined;
        globalThis.GM = undefined;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('persists with Safari Userscripts async GM.* when classic functions are absent', async () => {
        const values = new Map<string, unknown>();
        globalThis.GM = {
            async getValue(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
            async setValue(key, value) { values.set(key, value); },
            async deleteValue(key) { values.delete(key); },
            async listValues() { return [...values.keys()]; },
        };

        await setStoredValue('local:safari', {on: true});
        expect(values.get('local:safari')).toBe('{"on":true}');
        await expect(getStoredValue('local:safari')).resolves.toEqual({on: true});
        await expect(listStoredKeys()).resolves.toEqual(['local:safari']);
        await removeStoredValue('local:safari');
        await expect(listStoredKeys()).resolves.toEqual([]);
    });

    it('serializes objects for legacy GM implementations', async () => {
        const values = new Map<string, unknown>();
        globalThis.GM_getValue = ((key, fallback) => values.has(key) ? values.get(key) : fallback) as NonNullable<typeof globalThis.GM_getValue>;
        globalThis.GM_setValue = (key, value) => { values.set(key, value); };
        globalThis.GM_deleteValue = (key) => { values.delete(key); };
        globalThis.GM_listValues = () => [...values.keys()];

        await setStoredValue('local:config', {service: 'freeTranslation', on: true});
        expect(values.get('local:config')).toBe('{"service":"freeTranslation","on":true}');
        await expect(getStoredValue('local:config')).resolves.toEqual({service: 'freeTranslation', on: true});
        await expect(listStoredKeys()).resolves.toEqual(['local:config']);

        await removeStoredValue('local:config');
        await expect(getStoredValue('local:config')).resolves.toBeNull();
    });

    it('reads plain strings left by the 2024 userscript', async () => {
        globalThis.GM_getValue = ((key, fallback) => key === 'model' ? 'microsoft' : fallback) as NonNullable<typeof globalThis.GM_getValue>;
        await expect(getStoredValue('model')).resolves.toBe('microsoft');
    });

    it('enumerates only string keys and keeps its in-memory fallback usable without GM listValues', async () => {
        await setStoredValue('local:fallback-list', {value: 1});
        const keys = await listStoredKeys();
        expect(keys).toContain('local:fallback-list');
        expect(new Set(keys).size).toBe(keys.length);
        globalThis.GM_listValues = (() => ['local:valid', 7, null]) as NonNullable<typeof globalThis.GM_listValues>;
        await expect(listStoredKeys()).resolves.toEqual(['local:valid']);
        globalThis.GM_listValues = (() => ({unexpected: true})) as unknown as NonNullable<typeof globalThis.GM_listValues>;
        await expect(listStoredKeys()).resolves.toEqual([]);
    });

    it('refreshes non-JSON primitive values returned by the manager without losing its observer', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        vi.stubGlobal('document', new EventTarget());
        let value = 1n;
        globalThis.GM_getValue = (() => value) as NonNullable<typeof globalThis.GM_getValue>;
        const received = vi.fn();
        const stop = storage.watch('local:external-bigint', received);
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            value = 2n;
            target.dispatchEvent(new Event('focus'));
            await vi.waitFor(() => expect(received).toHaveBeenCalledWith(2n, 1n));
        } finally {stop();}
    });

    it.each(['save', 'remove'] as const)('does not report a committed %s as failed when one observer throws', async action => {
        const key = `local:observer-${action}`;
        await setStoredValue(key, {revision: 1});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const broken = storage.watch(key, () => {throw new Error('observer failure');});
        const received = vi.fn();
        const healthy = storage.watch(key, received);
        try {
            const next = action === 'save' ? {revision: 2} : null;
            await expect(action === 'save' ? setStoredValue(key, next) : removeStoredValue(key)).resolves.toBeUndefined();
            await expect(getStoredValue(key)).resolves.toEqual(next);
            expect(received).toHaveBeenCalledOnce();
            expect(received).toHaveBeenCalledWith(next, {revision: 1});
            expect(warn).toHaveBeenCalledOnce();
        } finally {broken(); healthy();}
    });

    it('consumes a rejected initialization from a replaced subscription without warning about its successor',async()=>{
        let reject!:(error:Error)=>void;const initial=new Promise<unknown>((_resolve,no)=>{reject=no;});
        globalThis.GM={getValue:vi.fn().mockReturnValueOnce(initial).mockResolvedValue(JSON.stringify({revision:2})),setValue:vi.fn()};
        const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined),received=vi.fn();
        const old=storage.watch('local:replaced-init',vi.fn());old();const fresh=storage.watch('local:replaced-init',received);
        try{await new Promise(resolve=>setTimeout(resolve,0));reject(new Error('old manager read failed'));await new Promise(resolve=>setTimeout(resolve,0));
            expect(warn).not.toHaveBeenCalled();await setStoredValue('local:replaced-init',{revision:3});
            expect(received).toHaveBeenCalledWith({revision:3},{revision:2});
        }finally{fresh();}
    });

    it('delivers external focus refreshes to remaining observers after an earlier observer fails', async () => {
        const target = new EventTarget();
        const documentTarget = Object.assign(new EventTarget(), {visibilityState: 'visible'});
        vi.stubGlobal('window', target);
        vi.stubGlobal('document', documentTarget);
        let stored = JSON.stringify({revision: 1});
        globalThis.GM_getValue = (() => stored) as NonNullable<typeof globalThis.GM_getValue>;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const broken = storage.watch('local:external-observer', () => {throw new Error('observer failure');});
        const received = vi.fn();
        const healthy = storage.watch('local:external-observer', received);
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            stored = JSON.stringify({revision: 2});
            target.dispatchEvent(new Event('focus'));
            await vi.waitFor(() => expect(received).toHaveBeenCalledWith({revision: 2}, {revision: 1}));
            expect(received).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledOnce();
            target.dispatchEvent(new Event('focus'));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(received).toHaveBeenCalledOnce();
            stored=JSON.stringify({revision:3});documentTarget.visibilityState='hidden';documentTarget.dispatchEvent(new Event('visibilitychange'));
            await new Promise(resolve=>setTimeout(resolve,0));expect(received).toHaveBeenCalledOnce();
            documentTarget.visibilityState='visible';documentTarget.dispatchEvent(new Event('visibilitychange'));
            await vi.waitFor(()=>expect(received).toHaveBeenCalledWith({revision:3},{revision:2}));expect(received).toHaveBeenCalledTimes(2);
        } finally {broken(); healthy();}
    });

    it('blocks the shared config store until userscript migration has completed', async () => {
        const values = new Map<string, unknown>([
            ['local:config', JSON.stringify({count: 16})],
        ]);
        let reads = 0;
        globalThis.GM_getValue = ((key, fallback) => {
            reads += 1;
            return values.has(key) ? values.get(key) : fallback;
        }) as NonNullable<typeof globalThis.GM_getValue>;
        globalThis.GM_setValue = (key, value) => { values.set(key, value); };

        const changes: unknown[] = [];
        const stopWatching = configStorage.watch('local:config', (value) => changes.push(value));

        const pending = configStorage.getItem<{count: number}>('local:config');
        await Promise.resolve();
        expect(reads).toBe(0);

        completeUserscriptConfigPreparation();
        await expect(pending).resolves.toEqual({count: 16});
        await Promise.resolve();
        await setStoredValue('local:config', {count: 17});
        expect(reads).toBeGreaterThanOrEqual(1);
        expect(changes).toEqual([{count: 17}]);

        stopWatching();
        await setStoredValue('local:config', {count: 18});
        expect(changes).toEqual([{count: 17}]);
        completeUserscriptConfigPreparation();
    });

    it('rejects eager config reads on preparation failure and cancels deferred watches', async () => {
        vi.resetModules();
        const rejectedStorage = await import('@/userscript/storage');
        const rejectedRead = rejectedStorage.configStorage.getItem('local:config');
        const rejectedChanges: unknown[] = [];
        rejectedStorage.configStorage.watch('local:config', (value) => rejectedChanges.push(value));
        rejectedStorage.failUserscriptConfigPreparation(new Error('migration failed'));

        await expect(rejectedRead).rejects.toThrow('migration failed');
        await Promise.resolve();
        await rejectedStorage.setStoredValue('local:config', {count: 1});
        expect(rejectedChanges).toEqual([]);
        rejectedStorage.failUserscriptConfigPreparation(new Error('ignored repeat'));
        rejectedStorage.completeUserscriptConfigPreparation();

        vi.resetModules();
        const cancelledStorage = await import('@/userscript/storage');
        const cancelledChanges: unknown[] = [];
        const cancel = cancelledStorage.configStorage.watch(
            'local:config',
            (value) => cancelledChanges.push(value),
        );
        cancel();
        cancelledStorage.completeUserscriptConfigPreparation();
        await Promise.resolve();
        await cancelledStorage.setStoredValue('local:config', {count: 2});
        expect(cancelledChanges).toEqual([]);
        cancel();
    });
});

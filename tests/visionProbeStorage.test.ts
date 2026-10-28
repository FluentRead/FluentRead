import {describe, expect, it, vi} from 'vitest';
const storage=vi.hoisted(()=>({getItem:vi.fn(async (_key: string): Promise<unknown> => []),setItem:vi.fn(async (_key: string, _value: unknown): Promise<void> => undefined)}));
const transport=vi.hoisted(()=>({translate:vi.fn(async (_request: unknown) => 'ABCDEF')}));
vi.mock('@wxt-dev/storage',()=>({storage}));
vi.mock('@/src/app/translation/runtime',()=>({translateWithCache:transport.translate}));
import {visionProbeStorage, VISION_PROBE_STORAGE_KEY} from '@/src/platform/storage/visionProbeStorage';
describe('本地识图结论存储',()=>{
    it('独立键读写最小能力记录，不进入用户配置',async()=>{
        expect(VISION_PROBE_STORAGE_KEY).toBe('local:modelVisionProbe:v1');
        await expect(visionProbeStorage.load()).resolves.toEqual([]);
        const records=[{identity:'a'.repeat(64),capability:'supported' as const,checkedAt:100}];
        await visionProbeStorage.save(records);
        expect(storage.getItem).toHaveBeenCalledWith(VISION_PROBE_STORAGE_KEY);
        expect(storage.setItem).toHaveBeenCalledWith(VISION_PROBE_STORAGE_KEY,records);
    });
});

describe('真实识图装配入口', () => {
    it('调用共享翻译端口，保存最小结果并在实例重建后读取同一持久缓存', async () => {
        let stored: unknown = [];
        storage.getItem.mockClear(); storage.setItem.mockClear();
        storage.getItem.mockImplementation(async () => stored);
        storage.setItem.mockImplementation(async (_key, value) => {stored = structuredClone(value);});
        transport.translate.mockClear();
        vi.stubGlobal('crypto', {getRandomValues: (value: Uint8Array) => {value.set([0xab, 0xcd, 0xef]); return value;}});
        try {
            vi.resetModules();
            const {Config} = await import('@/src/core/config/model');
            const {getTranslationImageInput} = await import('@/src/services/translation/requestSnapshot');
            const {createVisionProbeIdentity} = await import('@/src/core/config/visionProbe');
            const source = new Config();
            source.model.deepseek = 'future-vision'; source.token.deepseek = 'fixture-secret';
            const {modelVisionProbe} = await import('@/src/app/translation/visionProbeRuntime');
            await expect(modelVisionProbe.resolve(source, 'deepseek', 'future-vision', {force: true})).resolves.toMatchObject({capability: 'supported', source: 'probe'});
            expect(transport.translate).toHaveBeenCalledOnce();
            const request = transport.translate.mock.calls[0]![0] as {serviceOverride: string; modelOverride: string; useCache: boolean};
            expect(request).toMatchObject({serviceOverride: 'deepseek', modelOverride: 'future-vision', useCache: false});
            expect(getTranslationImageInput(request as never)).toMatch(/^data:image\/png;base64,/u);
            expect(storage.getItem).toHaveBeenCalledWith(VISION_PROBE_STORAGE_KEY);
            expect(storage.setItem).toHaveBeenCalledWith(VISION_PROBE_STORAGE_KEY, expect.arrayContaining([expect.objectContaining({capability: 'supported'})]));
            expect(stored).toEqual([{identity: createVisionProbeIdentity(source, 'deepseek', 'future-vision'), capability: 'supported', checkedAt: expect.any(Number)}]);
            expect(Number.isFinite((stored as Array<{checkedAt: number}>)[0]!.checkedAt)).toBe(true);
            expect(JSON.stringify(stored)).not.toContain('fixture-secret');
            await expect(modelVisionProbe.resolve(source, 'deepseek', 'future-vision')).resolves.toMatchObject({capability: 'supported', source: 'probe'});
            vi.resetModules();
            const restarted = (await import('@/src/app/translation/visionProbeRuntime')).modelVisionProbe;
            await expect(restarted.resolve(source, 'deepseek', 'future-vision')).resolves.toMatchObject({capability: 'supported', source: 'probe'});
            expect(transport.translate).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
            storage.getItem.mockReset().mockResolvedValue([]);
            storage.setItem.mockReset().mockResolvedValue(undefined);
        }
    });
});

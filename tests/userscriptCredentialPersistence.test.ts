import {beforeEach, describe, expect, it, vi} from 'vitest';

const userscriptStorage = vi.hoisted(() => ({
    values: new Map<string, unknown>(),
    writes: [] as Array<[string, unknown]>,
}));

const userscriptStoragePort = vi.hoisted(() => ({
    getItem: vi.fn(async (key: string) => userscriptStorage.values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
        const snapshot = structuredClone(value);
        userscriptStorage.values.set(key, snapshot);
        userscriptStorage.writes.push([key, snapshot]);
    }),
    removeItem: vi.fn(async (key: string) => {
        userscriptStorage.values.delete(key);
    }),
    watch: vi.fn(() => () => undefined),
}));

vi.mock('@wxt-dev/storage', () => ({
    storage: userscriptStoragePort,
}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: userscriptStoragePort}));

// Userscript Vite 使用同名平台替换模块；这里验证该可信 GM 模式下的完整读写生命周期。
vi.mock('@/src/platform/storage/credentialContext', () => ({
    isTrustedCredentialStorageContext: () => true,
}));

// 平台适配器的翻译、词典与连接测试依赖与配置持久化无关，保持为惰性替身。
vi.mock('@/src/app/translation/runtime', () => ({
    cleanupTranslationCache: vi.fn(),
    clearTranslationCache: vi.fn(),
    translateWithCache: vi.fn(),
}));
vi.mock('@/src/providers/translation/connectionTest', () => ({runTranslationServiceConnectionTest: vi.fn()}));
vi.mock('@/src/features/selection-translation/services/wordDictionary', () => ({lookupWord: vi.fn()}));
vi.mock('@/userscript/count', () => ({incrementUserscriptConfigCount: vi.fn()}));

async function loadConfigStore() {
    vi.resetModules();
    const module = await import('@/src/services/config/store');
    await Promise.all([module.configReady, module.configHistoryReady]);
    return module;
}

describe('userscript credential persistence regression', () => {
    beforeEach(() => {
        userscriptStorage.values.clear();
        userscriptStorage.writes.length = 0;
    });

    it('从旧 GM 配置迁移、保存公开设置并重载后仍保留 Token', async () => {
        userscriptStorage.values.set('local:config', {
            on: true,
            service: 'openai',
            from: 'auto',
            to: 'zh-Hans',
            token: {openai: 'gm-secret-token'},
        });

        const first = await loadConfigStore();
        expect(first.config.token.openai).toBe('gm-secret-token');
        expect(userscriptStorage.values.get('local:credentials')).toEqual(
            expect.objectContaining({token: {openai: 'gm-secret-token'}}),
        );
        expect(userscriptStorage.values.has('session:credentials')).toBe(false);

        first.config.to = 'ja';
        await first.saveConfig(first.config, {recordHistory: true, immediateHistory: true});
        const publicConfig = userscriptStorage.values.get('local:config') as Record<string, unknown>;
        expect(publicConfig.to).toBe('ja');
        expect(publicConfig).not.toHaveProperty('token');
        expect(userscriptStorage.values.get('local:credentials')).toEqual(
            expect.objectContaining({token: {openai: 'gm-secret-token'}}),
        );

        const reloaded = await loadConfigStore();
        expect(reloaded.config.to).toBe('ja');
        expect(reloaded.config.token.openai).toBe('gm-secret-token');
    });

    it('共享组件经 runtime 消息提交字段补丁时，同页适配器不把补丁当成整份配置', async () => {
        userscriptStorage.values.set('local:config', {
            on: true,
            service: 'openai',
            from: 'auto',
            to: 'ja',
            floatingBallPosition: 'right',
            token: {openai: 'gm-secret-token'},
        });
        const store = await loadConfigStore();
        const {createPlatformMessageHandler} = await import('@/userscript/platform');
        const handler = createPlatformMessageHandler(vi.fn());

        // 悬浮球拖到另一侧时与扩展一致地发送 patch；userscript 没有独立后台 store。
        await store.requestConfigPatch({floatingBallPosition: 'left'}, (message) => handler(message));
        expect(store.config).toMatchObject({floatingBallPosition: 'left', service: 'openai', to: 'ja'});
        expect(store.config.token.openai).toBe('gm-secret-token');

        // 整份保存同样需要返回提交 revision，发送方才不会把成功写入当成失败并回滚。
        await store.requestConfigSave({...store.config, to: 'ko'}, (message) => handler(message));

        const reloaded = await loadConfigStore();
        expect(reloaded.config).toMatchObject({floatingBallPosition: 'left', service: 'openai', to: 'ko'});
        expect(reloaded.config.token.openai).toBe('gm-secret-token');
    });
});

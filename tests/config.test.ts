import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as ts from 'typescript';
import { normalizeConfig, type Config } from '@/src/core/config/model';
import { sanitizeConfigCredentials } from '@/src/core/config/credentials';
import { customModelString, services } from '@/src/core/config/catalog';

const storageMock = vi.hoisted(() => ({
    writeOwner: true,
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    watch: vi.fn(),
}));
const atomicSetItemsMock = vi.hoisted(() => vi.fn());

vi.mock('@wxt-dev/storage', () => ({ storage: storageMock }));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: storageMock}));

const storedConfig = {
    on: true,
    service: 'openai',
    from: 'auto',
    to: 'zh-Hans',
};

const storageState = new Map<string, unknown>();
const storageOperations: string[] = [];
const storageWatchers = new Map<string, (value: unknown) => void>();

interface LoadConfigOptions {
    trusted?: boolean;
    history?: unknown;
    sessionCredentials?: unknown;
    localCredentials?: unknown;
    configReadBarrier?: Promise<void>;
    localCredentialReadBarrier?: Promise<void>;
    failLocalCredentialRead?: boolean;
    failSessionRead?: boolean;
    failLocalCredentialWrite?: boolean;
    failLocalCredentialVerification?: boolean;
    atomicSetItems?: boolean;
    failAtomicCommit?: boolean;
    writeOwner?: boolean;
}

async function loadConfigModule(value: unknown = null, options: LoadConfigOptions = {}) {
    vi.resetModules();
    storageState.clear();
    storageOperations.length = 0;
    storageWatchers.clear();
    storageMock.writeOwner = options.writeOwner !== false;
    let localCredentialWritten = false;
    if (value !== null) storageState.set('local:config', value);
    if (options.history !== undefined) storageState.set('local:configHistory', options.history);
    if (options.sessionCredentials !== undefined) storageState.set('session:credentials', options.sessionCredentials);
    if (options.localCredentials !== undefined) storageState.set('local:credentials', options.localCredentials);
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {protocol: options.trusted === false ? 'https:' : 'chrome-extension:'},
    });
    storageMock.getItem.mockReset().mockImplementation(async (key: string) => {
        storageOperations.push(`get:${key}`);
        if (key === 'local:config' && options.configReadBarrier) {
            await options.configReadBarrier;
        }
        if (key === 'local:credentials' && options.localCredentialReadBarrier) {
            await options.localCredentialReadBarrier;
        }
        if (options.failLocalCredentialRead && key === 'local:credentials') {
            throw new Error('storage.local credentials unavailable');
        }
        if (options.failLocalCredentialVerification && key === 'local:credentials' && localCredentialWritten) {
            return {token: {openai: 'stale-readback-secret'}};
        }
        if (options.failSessionRead && key === 'session:credentials') {
            throw new Error('storage.session unavailable');
        }
        return storageState.get(key) ?? null;
    });
    storageMock.setItem.mockReset().mockImplementation(async (key: string, nextValue: unknown) => {
        storageOperations.push(`set:${key}`);
        if (options.failLocalCredentialWrite && key === 'local:credentials') {
            throw new Error('persistent credentials unavailable');
        }
        if (key === 'local:credentials') localCredentialWritten = true;
        storageState.set(key, structuredClone(nextValue));
    });
    storageMock.removeItem.mockReset().mockImplementation(async (key: string) => {
        storageOperations.push(`remove:${key}`);
        storageState.delete(key);
    });
    atomicSetItemsMock.mockReset().mockImplementation(async (
        entries: ReadonlyMap<string, unknown>,
        removeKeys: readonly string[] = [],
    ) => {
        storageOperations.push(`setItems:${[...entries.keys()].join(',')}:${removeKeys.join(',')}`);
        if (options.failAtomicCommit) throw new Error('atomic commit unavailable');
        const nextState = new Map(storageState);
        for (const [key, nextValue] of entries) nextState.set(key, structuredClone(nextValue));
        for (const key of removeKeys) nextState.delete(key);
        storageState.clear();
        for (const [key, nextValue] of nextState) storageState.set(key, nextValue);
    });
    if (options.atomicSetItems) {
        (storageMock as typeof storageMock & {setItems?: typeof atomicSetItemsMock}).setItems = atomicSetItemsMock;
    } else {
        delete (storageMock as typeof storageMock & {setItems?: typeof atomicSetItemsMock}).setItems;
    }
    storageMock.watch.mockReset().mockImplementation((key: string, callback: (value: unknown) => void) => {
        storageWatchers.set(key, callback);
        return () => storageWatchers.delete(key);
    });
    return import('@/src/services/config/store');
}

describe('统一配置存储', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('兼容旧 JSON 字符串，并只迁移成一次对象存储', async () => {
        const configStore = await loadConfigModule(JSON.stringify(storedConfig));

        await configStore.configReady;

        expect(storageMock.setItem).toHaveBeenCalledTimes(1);
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:config',
            expect.objectContaining(storedConfig),
        );
        expect(typeof storageMock.setItem.mock.calls[0][1]).toBe('object');
    });

    it('读取已经去凭据且带版本的规范化对象时不产生初始化回写', async () => {
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig);

        await configStore.configReady;

        expect(storageMock.setItem).not.toHaveBeenCalled();
        expect(configStore.config).toMatchObject(storedConfig);
    });

    it('IndexedDB 已有相同持久凭据时直接水合，不在启动时重复写回', async () => {
        const secret = 'existing-persistent-secret';
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            localCredentials: {token: {openai: secret}},
        });

        await configStore.configReady;

        expect(configStore.config.token.openai).toBe(secret);
        expect(storageMock.setItem).not.toHaveBeenCalled();
        expect(atomicSetItemsMock).not.toHaveBeenCalled();
        expect(storageMock.removeItem).not.toHaveBeenCalled();
    });

    it('页面立即请求完整导出时等待公开配置与凭据完成同一轮水合', async () => {
        let releaseCredentialRead!: () => void;
        const credentialReadBarrier = new Promise<void>(resolve => {
            releaseCredentialRead = resolve;
        });
        const secret = 'hydrated-export-secret';
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, to: 'ja'})),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            writeOwner: false,
            localCredentials: {token: {openai: secret}},
            localCredentialReadBarrier: credentialReadBarrier,
        });
        let settled = false;
        const exportedPromise = configStore.prepareHydratedConfigForExport()
            .finally(() => { settled = true; });

        await vi.waitFor(() => expect(storageOperations).toContain('get:local:credentials'));
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseCredentialRead();
        await expect(exportedPromise).resolves.toMatchObject({
            to: 'ja',
            token: {openai: secret},
        });
        const exported = await exportedPromise;
        expect(exported).not.toHaveProperty('count');
        expect(exported).not.toHaveProperty('__fluentConfigRevision');
    });

    it('完整导出等待乐观补丁结束，并在 revision 冲突回滚后读取权威快照', async () => {
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'})),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            writeOwner: false,
            localCredentials: {token: {openai: 'authoritative-secret'}},
        });
        await configStore.configReady;
        let releasePatch!: (value: {success: false; error: string}) => void;
        const patchResponse = new Promise<{success: false; error: string}>((resolve) => {
            releasePatch = resolve;
        });
        const sendMessage = vi.fn(() => patchResponse);

        const patch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        expect(configStore.config.theme).toBe('dark');
        let exportSettled = false;
        const exported = configStore.prepareHydratedConfigForExport()
            .finally(() => { exportSettled = true; });
        await Promise.resolve();
        expect(exportSettled).toBe(false);

        releasePatch({success: false, error: '配置已更新（当前 revision 6），请同步后重试'});
        await expect(patch).rejects.toThrow('配置已更新');
        await expect(exported).resolves.toMatchObject({
            theme: 'auto',
            token: {openai: 'authoritative-secret'},
        });
    });

    it('可信扩展页面只从后台水合凭据，不重复执行迁移或直接写 IndexedDB', async () => {
        const secret = 'remote-extension-page-secret';
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            writeOwner: false,
            localCredentials: {token: {openai: secret}},
        });

        await configStore.configReady;
        expect(configStore.config.token.openai).toBe(secret);
        expect(storageMock.setItem).not.toHaveBeenCalled();
        expect(storageMock.removeItem).not.toHaveBeenCalled();
        await expect(configStore.saveConfig({...configStore.config, to: 'en'}))
            .rejects.toThrow('必须通过后台配置协议保存');
    });

    it('可信页面水合凭据期间收到更高配置 revision 时整轮重读，不用旧快照回滚', async () => {
        let releaseCredentialRead!: () => void;
        const credentialReadBarrier = new Promise<void>(resolve => {
            releaseCredentialRead = resolve;
        });
        const oldConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, to: 'en'})),
            __fluentConfigRevision: 4,
        };
        const nextConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, to: 'ja'})),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(oldConfig, {
            writeOwner: false,
            localCredentialReadBarrier: credentialReadBarrier,
        });
        await vi.waitFor(() => {
            expect(storageOperations).toContain('get:local:credentials');
            expect(storageWatchers.has('local:config')).toBe(true);
        });

        storageState.set('local:config', nextConfig);
        storageWatchers.get('local:config')!(nextConfig);
        expect(configStore.config.to).toBe('ja');
        releaseCredentialRead();
        await configStore.configReady;

        expect(configStore.config.to).toBe('ja');
        expect(configStore.getConfigRevision()).toBe(5);
        expect(storageOperations.filter(operation => operation === 'get:local:config').length).toBeGreaterThan(1);
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it.each(['旧值', '读取失败'])('popup 首次凭据回读的%s 晚于广播时采用新 Key，延迟主配置广播不会保留旧凭据', async readOutcome => {
        let releaseConfigRead!: () => void;
        let releaseCredentialRead!: () => void;
        const configReadBarrier = new Promise<void>(resolve => { releaseConfigRead = resolve; });
        const credentialReadBarrier = new Promise<void>(resolve => { releaseCredentialRead = resolve; });
        const oldConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 4,
        };
        const nextCredentials = {token: {openai: 'updated-during-popup-hydration'}};
        const store = await loadConfigModule(oldConfig, {
            writeOwner: false,
            configReadBarrier,
            localCredentials: {token: {openai: 'old-popup-hydration-value'}},
        });
        const defaultRead = storageMock.getItem.getMockImplementation()!;
        let credentialReads = 0;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (key !== 'local:credentials') return defaultRead(key);
            storageOperations.push(`get:${key}`);
            // 后台已经读取旧值，但发回 popup 的响应仍在途。
            const snapshot = structuredClone(storageState.get(key));
            const firstRead = credentialReads++ === 0;
            await credentialReadBarrier;
            if (firstRead && readOutcome === '读取失败') throw new Error('stale credential read failed');
            return snapshot;
        });
        releaseConfigRead();
        await vi.waitFor(() => expect(storageOperations).toContain('get:local:credentials'));

        storageState.set('local:credentials', nextCredentials);
        storageWatchers.get('local:credentials')?.(nextCredentials);
        releaseCredentialRead();
        await store.configReady;
        const nextConfig = {...oldConfig, to: 'ja', __fluentConfigRevision: 5};
        storageState.set('local:config', nextConfig);
        storageWatchers.get('local:config')!(nextConfig);

        expect(store.config.to).toBe('ja');
        expect(store.config.token.openai).toBe(nextCredentials.token.openai);
        await expect(store.prepareHydratedConfigForExport()).resolves.toMatchObject({token: nextCredentials.token});
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it('凭据水合失败前收到更高 revision 时 fallback 也采用最新公开配置', async () => {
        let releaseCredentialRead!: () => void;
        const credentialReadBarrier = new Promise<void>(resolve => {
            releaseCredentialRead = resolve;
        });
        const oldConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, to: 'en'})),
            __fluentConfigRevision: 4,
        };
        const nextConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, to: 'ja'})),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(oldConfig, {
            writeOwner: false,
            localCredentialReadBarrier: credentialReadBarrier,
            failLocalCredentialRead: true,
        });
        await vi.waitFor(() => {
            expect(storageOperations).toContain('get:local:credentials');
            expect(storageWatchers.has('local:config')).toBe(true);
        });

        storageState.set('local:config', nextConfig);
        storageWatchers.get('local:config')!(nextConfig);
        expect(configStore.config.to).toBe('ja');
        releaseCredentialRead();
        await configStore.configReady;

        expect(configStore.config.to).toBe('ja');
        expect(configStore.getConfigRevision()).toBe(5);
        expect(storageOperations.filter(operation => operation === 'get:local:config').length).toBeGreaterThan(1);
        expect(storageMock.setItem).not.toHaveBeenCalled();
        const sendMessage = vi.fn();
        await expect(configStore.requestConfigSave({...configStore.config, to: 'zh-Hans'}, sendMessage))
            .rejects.toThrow('配置安全水合未完成');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('可信远程页迁移旧策略时无法读取 session 凭据会拒绝发送可能清空 API Key 的保存请求', async () => {
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            persistCredentials: false,
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            writeOwner: false,
            failSessionRead: true,
        });
        await configStore.configReady;
        const sendMessage = vi.fn();

        await expect(configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage))
            .rejects.toThrow('配置安全水合未完成');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('为旧配置补齐空的始终翻译域名列表，并只迁移回写一次', async () => {
        const legacyConfig = normalizeConfig(storedConfig) as unknown as Record<string, unknown>;
        delete legacyConfig.alwaysTranslateDomains;
        delete legacyConfig.disabledExtensionDomains;
        const configStore = await loadConfigModule(legacyConfig);

        await configStore.configReady;

        expect(configStore.config.alwaysTranslateDomains).toEqual([]);
        expect(configStore.config.disabledExtensionDomains).toEqual([]);
        const localConfigWrites = storageMock.setItem.mock.calls.filter(([key]) => key === 'local:config');
        expect(localConfigWrites).toHaveLength(1);
        expect(localConfigWrites[0][1]).toEqual(expect.objectContaining({alwaysTranslateDomains: []}));
        expect(localConfigWrites[0][1]).toEqual(expect.objectContaining({disabledExtensionDomains: []}));
    });

    it('识别范围通过统一配置保存、水合与外部变更持久同步', async () => {
        const store = await loadConfigModule(storedConfig);
        await store.configReady;
        expect(store.config.translationScope).toBe('content');
        await store.saveConfig({...store.config, translationScope: 'all'});
        const reopened = await loadConfigModule(storageState.get('local:config'));
        await reopened.configReady;
        expect(reopened.config.translationScope).toBe('all');
        const listener = vi.fn();
        reopened.subscribeConfig(listener);
        const external = {...reopened.config, translationScope: 'content', __fluentConfigRevision: 100};
        storageState.set('local:config', external);
        storageWatchers.get('local:config')!(external);
        await vi.waitFor(() => expect(reopened.config.translationScope).toBe('content'));
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({translationScope: 'content'}));
        expect(storageState.get('local:config')).toMatchObject({translationScope: 'content'});
    });

    it('缓存双上限随配置保存、重新加载和外部通知同步', async () => {
        const store = await loadConfigModule(storedConfig);
        await store.configReady;
        expect(store.config).toMatchObject({translationCacheMaxBytes: 5242880, translationCacheMaxEntries: 2000});
        await store.saveConfig({...store.config, translationCacheMaxBytes: 1048576, translationCacheMaxEntries: 100});
        const persisted = storageState.get('local:config');
        const reopened = await loadConfigModule(persisted);
        await reopened.configReady;
        expect(reopened.config).toMatchObject({translationCacheMaxBytes: 1048576, translationCacheMaxEntries: 100});
        const listener = vi.fn();
        reopened.subscribeConfig(listener);
        const external = {...reopened.config, translationCacheMaxEntries: 300, __fluentConfigRevision: 100};
        storageState.set('local:config', external);
        storageWatchers.get('local:config')!(external);
        await vi.waitFor(() => expect(reopened.config.translationCacheMaxEntries).toBe(300));
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({translationCacheMaxEntries: 300}));
    });

    it('内部 storage revision 不进入运行时配置或历史快照', async () => {
        const configStore = await loadConfigModule({...storedConfig, __fluentConfigRevision: 5});
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);

        expect((configStore.config as unknown as Record<string, unknown>).__fluentConfigRevision).toBeUndefined();
        await configStore.saveConfig({ ...configStore.config, to: 'en' }, {recordHistory: true, immediateHistory: true});

        const history = configStore.getConfigHistorySnapshot();
        expect(history.entries).toHaveLength(2);
        expect((history.entries[0].config as unknown as Record<string, unknown>).__fluentConfigRevision).toBeUndefined();
        expect((history.entries[1].config as unknown as Record<string, unknown>).__fluentConfigRevision).toBeUndefined();
    });

    it('旧配置保持图片和圈选开关，并为圈选补齐标准翻译和跟随服务', async () => {
        const configStore = await loadConfigModule({...storedConfig, selectionAreaEnabled: true, disableImageTranslator: true});
        await configStore.configReady;
        expect(configStore.config).toMatchObject({
            selectionAreaEnabled: true, disableImageTranslator: true,
            areaTranslationMode: 'standard', areaTranslationService: '',
        });
        expect(configStore.config.popupQuickFeatureOrder.filter(id => id === 'area')).toHaveLength(1);
        expect(configStore.config.popupQuickFeatureVisibility.area).toBe(true);
        await configStore.saveConfig({...configStore.config, areaTranslationMode: 'ai', areaTranslationService: 'openai'});
        expect(storageState.get('local:config')).toMatchObject({areaTranslationMode: 'ai', areaTranslationService: 'openai'});
    });

    it('翻译卡提示词经过保存与重载保持，占位符和用户空白不被改写', async () => {
        const store = await loadConfigModule(storedConfig);
        await store.configReady;
        const harness = {...store.config.harness, systemPrompt: 'Use {{to}}', actionPrompts: {...store.config.harness.actionPrompts, grammar: '  Custom {{learningLevel}}  '}};
        await store.saveConfig({...store.config, harness});
        const reopened = await loadConfigModule(storageState.get('local:config'));
        await reopened.configReady;
        expect(reopened.config.harness).toMatchObject({systemPrompt: 'Use {{to}}', actionPrompts: {grammar: '  Custom {{learningLevel}}  '}});
    });

    it('保留用户关闭视频、图片和圈选的选择，保存后重新加载仍关闭', async () => {
        const disabled = {videoTranslationEnabled: false, selectionAreaEnabled: false, disableImageTranslator: true};
        const store = await loadConfigModule({...storedConfig, ...disabled});
        await store.configReady;
        expect(store.config).toMatchObject(disabled);
        await store.saveConfig({...store.config, to: 'en'});
        const reopened = await loadConfigModule(storageState.get('local:config'));
        await reopened.configReady;
        expect(reopened.config).toMatchObject(disabled);
    });

    it('独立圈选服务接受机器翻译和已配置AI，拒绝畸形模式或孤立服务', () => {
        for (const service of ['microsoft', 'openai', 'deeplx', '']) {
            expect(normalizeConfig({areaTranslationService: service}).areaTranslationService).toBe(service);
        }
        for (const areaTranslationMode of [undefined, null, false, 'unknown', 'standard']) {
            expect(normalizeConfig({areaTranslationMode}).areaTranslationMode).toBe('standard');
        }
        expect(normalizeConfig({areaTranslationMode: 'ai'}).areaTranslationMode).toBe('ai');
        for (const areaTranslationService of [null, false, 12, 'unknown', 'custom:removed']) {
            expect(normalizeConfig({areaTranslationService}).areaTranslationService).toBe('');
        }
        const customOpenAIProviders = [{id: 'custom:area', name: 'Area AI', endpoint: 'https://example.com/v1/chat/completions', models: ['vision-or-text-model']}];
        expect(normalizeConfig({areaTranslationService: 'custom:area', customOpenAIProviders}).areaTranslationService).toBe('custom:area');
        expect(normalizeConfig({areaTranslationService: 'custom'}).customOpenAIProviders.some(provider => provider.id === 'custom')).toBe(true);
        const layout = normalizeConfig({popupQuickFeatureOrder: ['image', 'selection', 'area', 'area', 'unknown'], popupQuickFeatureVisibility: {image: false, area: false}});
        expect(layout.popupQuickFeatureOrder.filter(id => id === 'area')).toHaveLength(1);
        expect(layout.popupQuickFeatureVisibility).toMatchObject({image: false, area: false});
    });

    it('为旧配置默认开启视频、图片和圈选，并补齐视频服务和字号', async () => {
        const configStore = await loadConfigModule(storedConfig);

        await configStore.configReady;

        expect(configStore.config.videoTranslationEnabled).toBe(true);
        expect(configStore.config.selectionAreaEnabled).toBe(true);
        expect(configStore.config.disableImageTranslator).toBe(false);
        expect(configStore.config.videoService).toBe('microsoft');
        expect(configStore.config.videoLocalModel).toBe('tiny');
        expect(configStore.config.videoSubtitleVisible).toBe(true);
        expect(configStore.config.videoSubtitleDisplayMode).toBe('bilingual');
        expect(configStore.config.videoSubtitleFontSize).toBe(100);
        expect(configStore.config.fullPageTranslationMode).toBe('viewport');
    });

    it('为文档翻译补齐独立服务和模型，并保留网页模型选择', async () => {
        const configStore = await loadConfigModule({
            ...storedConfig,
            service: 'openai',
            model: {openai: 'web-model'},
            documentService: 'openai',
            documentModel: {openai: 'document-model'},
        });

        await configStore.configReady;

        expect(configStore.config.documentService).toBe('openai');
        expect(configStore.config.documentModel.openai).toBe(customModelString);
        expect(configStore.config.documentCustomModel.openai).toBe('document-model');
        expect(configStore.config.model.openai).toBe(customModelString);
        expect(configStore.config.customModel.openai).toBe('web-model');
        expect(configStore.config.customModels.openai).toEqual(expect.arrayContaining([
            'web-model',
            'document-model',
        ]));
    });

    it('文档翻译遇到未知服务时回退到免费翻译服务', async () => {
        const configStore = await loadConfigModule({...storedConfig, documentService: 'unknown-service'});

        await configStore.configReady;

        expect(configStore.config.documentService).toBe('freeTranslation');
    });

    it('保留用户选择的视频 AI 服务，并将未知服务回退到微软翻译', async () => {
        const aiConfigStore = await loadConfigModule({ ...storedConfig, videoService: 'openai' });

        await aiConfigStore.configReady;

        expect(aiConfigStore.config.videoService).toBe('openai');

        const invalidConfigStore = await loadConfigModule({ ...storedConfig, videoService: 'not-a-service' });

        await invalidConfigStore.configReady;

        expect(invalidConfigStore.config.videoService).toBe('microsoft');
    });

    it('把早期 Beta 写入的 DeepLX 默认值一次迁移为微软翻译', async () => {
        const configStore = await loadConfigModule({ ...storedConfig, videoService: 'deeplx' });

        await configStore.configReady;

        expect(configStore.config.videoService).toBe('microsoft');
        expect(configStore.config.videoServiceDefaultMigrated).toBe(true);
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:config',
            expect.objectContaining({ videoService: 'microsoft', videoServiceDefaultMigrated: true }),
        );
    });

    it('非法的视频字幕显示配置回退到双语和显示状态', async () => {
        const configStore = await loadConfigModule({
            ...storedConfig,
            videoSubtitleVisible: 'yes',
            videoSubtitleDisplayMode: 'side-by-side',
            videoSubtitleFontSize: 'huge',
        });

        await configStore.configReady;

        expect(configStore.config.videoSubtitleVisible).toBe(true);
        expect(configStore.config.videoSubtitleDisplayMode).toBe('bilingual');
        expect(configStore.config.videoSubtitleFontSize).toBe(100);
    });

    it('非法的本地视频 Whisper 模型回退到 Tiny', async () => {
        const configStore = await loadConfigModule({ ...storedConfig, videoLocalModel: 'large' });

        await configStore.configReady;

        expect(configStore.config.videoLocalModel).toBe('tiny');
    });

    it('存储内容损坏时回退到默认配置，并保持初始化 Promise 可用', async () => {
        const configStore = await loadConfigModule('{not-json');

        await expect(configStore.configReady).resolves.toBeUndefined();

        expect(configStore.config.on).toBe(true);
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:config',
            expect.objectContaining({ on: true }),
        );
    });

    it('保存相同快照时去重，并让连续保存只保留最新快照', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        storageMock.setItem.mockClear();

        const firstSave = configStore.saveConfig({ ...configStore.config, on: false });
        const latestSave = configStore.saveConfig({ ...configStore.config, on: true, to: 'en' });
        await Promise.all([firstSave, latestSave]);

        expect(storageMock.setItem.mock.calls.filter(([key]) => key === 'local:config')).toHaveLength(1);
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:config',
            expect.objectContaining({ on: true, to: 'en' }),
        );
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:credentials',
            expect.objectContaining({token: {}}),
        );

        storageMock.setItem.mockClear();
        await configStore.saveConfig({ ...configStore.config, on: true, to: 'en' });
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it('收到外部对象更新时立即同步运行时状态，并通知订阅者', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const listener = vi.fn();
        const unsubscribe = configStore.subscribeConfig(listener);
        const watchCallback = storageMock.watch.mock.calls[0][1];

        watchCallback({ ...storedConfig, on: false }, storedConfig);

        expect(configStore.config.on).toBe(false);
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ on: false }));
        unsubscribe();
    });

    it('外部更新不会被本地 watcher 再次写回，取消订阅后也不再通知', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const listener = vi.fn();
        const unsubscribe = configStore.subscribeConfig(listener);
        const watchCallback = storageMock.watch.mock.calls[0][1];
        listener.mockClear();
        storageMock.setItem.mockClear();

        watchCallback({ ...storedConfig, on: false }, storedConfig);
        unsubscribe();
        watchCallback({ ...storedConfig, on: true }, { ...storedConfig, on: false });

        expect(storageMock.setItem).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('短生命周期页面通过后台提交规范化快照，而不是自行承担落盘', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        storageMock.setItem.mockClear();
        const sendMessage = vi.fn().mockResolvedValue({ success: true, revision: 2 });

        await configStore.requestConfigSave({ ...configStore.config, to: 'en' }, sendMessage);

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: configStore.CONFIG_PERSIST_MESSAGE,
            config: expect.objectContaining({ to: 'en' }),
            baseRevision: 1,
        }));
        expect(configStore.getConfigRevision()).toBe(2);
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it('设置页嵌套草稿与运行时基线隔离，编辑 user_role 后产生非空 patch 并落盘', async () => {
        const userRole = 'base user prompt {{to}} {{origin}}';
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig({
                ...storedConfig,
                service: 'openai',
                user_role: {openai: userRole},
                system_role: {openai: 'base system prompt'},
            })),
            __fluentConfigRevision: 7,
        };
        const configStore = await loadConfigModule(canonicalConfig);
        await configStore.configReady;
        storageMock.setItem.mockClear();
        storageOperations.length = 0;

        // This is the settings-page hydration boundary after the fix. normalizeConfig
        // must clone nested mappings before the editor mutates its local draft.
        const draft = normalizeConfig(configStore.config);
        expect(draft.user_role).not.toBe(configStore.config.user_role);
        const editedUserRole = 'edited user prompt {{to}} {{origin}}';
        draft.user_role.openai = editedUserRole;
        expect(configStore.config.user_role.openai).toBe(userRole);

        await configStore.requestConfigPatch(draft);

        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:config',
            expect.objectContaining({user_role: expect.objectContaining({openai: editedUserRole})}),
        );
        expect(configStore.config.user_role.openai).toBe(editedUserRole);
        expect(storageOperations).toContain('set:local:config');
    });

    it.each([
        ['轮换', {openai: 'remote-imported-secret'}],
        ['清除', {}],
    ] as const)('远程整份凭据%s成功后不依赖凭据通知即可同步导出与后续整份保存', async (_operation, importedToken) => {
        const oldSecret = 'remote-old-secret';
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: {openai: oldSecret}},
        });
        await configStore.configReady;
        const sentTokens: Array<Record<string, string>> = [];
        const sendMessage = vi.fn(async (message: {config: Config; baseRevision: number}) => {
            const token = structuredClone(message.config.token);
            sentTokens.push(token);
            const revision = message.baseRevision + 1;
            storageState.set('local:credentials', {token});
            storageState.set('local:config', {
                ...sanitizeConfigCredentials(normalizeConfig(message.config)),
                __fluentConfigRevision: revision,
            });
            // 模拟 local:credentials 广播延迟或丢失；请求方只能依赖本次成功响应。
            return {success: true, revision};
        });

        await configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
            to: 'ja',
        }, sendMessage);
        const exported = await configStore.prepareHydratedConfigForExport();
        await configStore.requestConfigSave(configStore.config, sendMessage);

        expect({
            runtimeToken: configStore.config.token,
            exportedToken: exported.token,
            sentTokens,
        }).toEqual({
            runtimeToken: importedToken,
            exportedToken: importedToken,
            sentTokens: [importedToken, importedToken],
        });
    });

    it.each([
        ['轮换', {openai: 'queued-imported-secret'}],
        ['清除', {}],
    ] as const)('远程整份凭据%s响应前排入的普通 replace 继承前驱已提交凭据', async (_operation, importedToken) => {
        const oldToken = {openai: 'queued-old-secret'};
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        const sent: Array<{token: Record<string, string>; baseRevision: number; theme: string}> = [];
        const sendMessage = vi.fn(async (message: {config: Config; baseRevision: number}) => {
            if (sent.length === 0) await firstResponseGate;
            const token = structuredClone(message.config.token);
            sent.push({token, baseRevision: message.baseRevision, theme: message.config.theme});
            const revision = message.baseRevision + 1;
            storageState.set('local:credentials', {token});
            storageState.set('local:config', {
                ...sanitizeConfigCredentials(normalizeConfig(message.config)),
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
            to: 'ja',
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const pageExitSnapshot = configStore.requestConfigSave({
            ...configStore.config,
            theme: 'dark',
        }, sendMessage);
        releaseFirstResponse();
        await Promise.all([imported, pageExitSnapshot]);
        const exported = await configStore.prepareHydratedConfigForExport();

        expect({
            runtimeToken: configStore.config.token,
            exportedToken: exported.token,
            theme: configStore.config.theme,
            sent,
        }).toEqual({
            runtimeToken: importedToken,
            exportedToken: importedToken,
            theme: 'dark',
            sent: [
                {token: importedToken, baseRevision: 4, theme: 'auto'},
                {token: importedToken, baseRevision: 5, theme: 'dark'},
            ],
        });
    });

    it('响应前排入且显式修改凭据的 replace 保持自身凭据意图', async () => {
        const oldToken = {openai: 'explicit-old-secret'};
        const firstToken = {openai: 'explicit-first-secret'};
        const latestToken = {openai: 'explicit-latest-secret'};
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        const sent: Array<{token: Record<string, string>; baseRevision: number}> = [];
        const sendMessage = vi.fn(async (message: {config: Config; baseRevision: number}) => {
            if (sent.length === 0) await firstResponseGate;
            const token = structuredClone(message.config.token);
            sent.push({token, baseRevision: message.baseRevision});
            const revision = message.baseRevision + 1;
            storageState.set('local:credentials', {token});
            storageState.set('local:config', {
                ...sanitizeConfigCredentials(normalizeConfig(message.config)),
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const first = configStore.requestConfigSave({...configStore.config, token: firstToken}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const latest = configStore.requestConfigSave({...configStore.config, token: latestToken}, sendMessage);
        releaseFirstResponse();
        await Promise.all([first, latest]);
        const exported = await configStore.prepareHydratedConfigForExport();

        expect(configStore.config.token).toEqual(latestToken);
        expect(exported.token).toEqual(latestToken);
        expect(sent).toEqual([
            {token: firstToken, baseRevision: 4},
            {token: latestToken, baseRevision: 5},
        ]);
    });

    it('远程凭据 replace 响应前排入的公开 patch 保留前驱凭据并继续提交公开字段', async () => {
        const oldToken = {openai: 'patch-old-secret'};
        const importedToken = {openai: 'patch-imported-secret'};
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        const sent: Array<{mode: string; baseRevision: number; hasToken: boolean}> = [];
        let authoritativeToken: Record<string, string> = oldToken;
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config | Record<string, unknown>;
            baseRevision: number;
        }) => {
            if (sent.length === 0) await firstResponseGate;
            const mode = message.mode || 'replace';
            const hasToken = Object.prototype.hasOwnProperty.call(message.config, 'token');
            sent.push({mode, baseRevision: message.baseRevision, hasToken});
            if (mode === 'replace') {
                authoritativeToken = structuredClone((message.config as Config).token);
            }
            const revision = message.baseRevision + 1;
            const currentPublic = storageState.get('local:config') as Record<string, unknown>;
            storageState.set('local:credentials', {token: authoritativeToken});
            storageState.set('local:config', {
                ...currentPublic,
                ...sanitizeConfigCredentials(normalizeConfig({
                    ...currentPublic,
                    ...message.config,
                })),
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
            to: 'ja',
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const publicPatch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        releaseFirstResponse();
        await Promise.all([imported, publicPatch]);
        const exported = await configStore.prepareHydratedConfigForExport();

        expect(configStore.config).toMatchObject({token: importedToken, theme: 'dark'});
        expect(exported).toMatchObject({token: importedToken, theme: 'dark'});
        expect(sent).toEqual([
            {mode: 'replace', baseRevision: 4, hasToken: true},
            {mode: 'patch', baseRevision: 5, hasToken: false},
        ]);
    });

    it('凭据 replace 后连续排入的多个公开 patch 都继承已提交凭据', async () => {
        const oldToken = {openai: 'multi-patch-old-secret'};
        const importedToken = {openai: 'multi-patch-imported-secret'};
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        let revision = 4;
        let authoritativeToken: Record<string, string> = oldToken;
        let authoritativePublic = canonical;
        const sent: Array<{mode: string; baseRevision: number; hasToken: boolean}> = [];
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config | Record<string, unknown>;
            baseRevision: number;
        }) => {
            invocation += 1;
            if (invocation === 1) await firstResponseGate;
            const mode = message.mode || 'replace';
            sent.push({
                mode,
                baseRevision: message.baseRevision,
                hasToken: Object.prototype.hasOwnProperty.call(message.config, 'token'),
            });
            if (mode === 'replace') {
                authoritativeToken = structuredClone((message.config as Config).token);
                authoritativePublic = sanitizeConfigCredentials(normalizeConfig(message.config));
            } else {
                authoritativePublic = {
                    ...authoritativePublic,
                    ...sanitizeConfigCredentials(message.config),
                };
            }
            revision += 1;
            storageState.set('local:credentials', {token: authoritativeToken});
            storageState.set('local:config', {
                ...authoritativePublic,
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const firstPatch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        const secondPatch = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        releaseFirstResponse();
        await Promise.all([imported, firstPatch, secondPatch]);
        const exported = await configStore.prepareHydratedConfigForExport();

        expect(configStore.config).toMatchObject({token: importedToken, theme: 'dark', to: 'ja'});
        expect(exported).toMatchObject({token: importedToken, theme: 'dark', to: 'ja'});
        expect(sent).toEqual([
            {mode: 'replace', baseRevision: 4, hasToken: true},
            {mode: 'patch', baseRevision: 5, hasToken: false},
            {mode: 'patch', baseRevision: 4, hasToken: false},
        ]);
    });

    it('中间公开 patch 失败后队尾 patch 仍使用最近已提交凭据', async () => {
        const oldToken = {openai: 'failed-middle-old-secret'};
        const importedToken = {openai: 'failed-middle-imported-secret'};
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config | Record<string, unknown>;
            baseRevision: number;
        }) => {
            invocation += 1;
            if (invocation === 1) {
                await firstResponseGate;
                storageState.set('local:credentials', {token: importedToken});
                storageState.set('local:config', {
                    ...canonical,
                    __fluentConfigRevision: 5,
                });
                return {success: true, revision: 5};
            }
            if (invocation === 2) return {success: false, error: 'middle patch failed'};
            storageState.set('local:config', {
                ...canonical,
                ...sanitizeConfigCredentials(message.config),
                to: 'ja',
                __fluentConfigRevision: 6,
            });
            return {success: true, revision: 6};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const failedPatch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        const latestPatch = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        const results = Promise.allSettled([imported, failedPatch, latestPatch]);
        releaseFirstResponse();

        const settled = await results;
        const exported = await configStore.prepareHydratedConfigForExport();
        expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
        expect(configStore.config).toMatchObject({token: importedToken, theme: 'auto', to: 'ja'});
        expect(exported).toMatchObject({token: importedToken, theme: 'auto', to: 'ja'});
    });

    it('请求途中到达的更新凭据通知会刷新后续队列基线', async () => {
        const oldToken = {openai: 'watch-shadow-old-secret'};
        const watchedToken = {openai: 'watch-shadow-latest-secret'};
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        const credentialWatch = storageWatchers.get('local:credentials')!;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        let revision = 4;
        let publicConfig = canonical;
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config | Record<string, unknown>;
        }) => {
            invocation += 1;
            if (invocation === 1) await firstResponseGate;
            publicConfig = {
                ...publicConfig,
                ...sanitizeConfigCredentials(message.config),
            };
            revision += 1;
            storageState.set('local:config', {
                ...publicConfig,
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const firstPatch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const latestPatch = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        storageState.set('local:credentials', {token: watchedToken});
        credentialWatch({token: watchedToken});
        expect(configStore.config.token).toEqual(watchedToken);
        releaseFirstResponse();
        await Promise.all([firstPatch, latestPatch]);
        const exported = await configStore.prepareHydratedConfigForExport();

        expect(configStore.config).toMatchObject({token: watchedToken, theme: 'dark', to: 'ja'});
        expect(exported).toMatchObject({token: watchedToken, theme: 'dark', to: 'ja'});
    });

    it('排队 replace 只重改自己显式修改的凭据字段', async () => {
        const oldToken = {openai: 'partial-old-token'};
        const importedToken = {openai: 'partial-imported-token'};
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken, ak: 'partial-old-ak'},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sent: Array<{token: Record<string, string>; ak: string; baseRevision: number}> = [];
        const sendMessage = vi.fn(async (message: {config: Config; baseRevision: number}) => {
            invocation += 1;
            if (invocation === 1) await firstResponseGate;
            const credentials = {token: structuredClone(message.config.token), ak: message.config.ak};
            sent.push({...credentials, baseRevision: message.baseRevision});
            const revision = message.baseRevision + 1;
            storageState.set('local:credentials', credentials);
            storageState.set('local:config', {
                ...sanitizeConfigCredentials(normalizeConfig(message.config)),
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const partialEdit = configStore.requestConfigSave({
            ...configStore.config,
            ak: 'partial-latest-ak',
        }, sendMessage);
        releaseFirstResponse();
        await Promise.all([imported, partialEdit]);

        expect(configStore.config).toMatchObject({token: importedToken, ak: 'partial-latest-ak'});
        expect(sent).toEqual([
            {token: importedToken, ak: 'partial-old-ak', baseRevision: 4},
            {token: importedToken, ak: 'partial-latest-ak', baseRevision: 5},
        ]);
    });

    it('显式 exact replace 在排队后仍完整拥有入队时凭据快照', async () => {
        const oldToken = {openai: 'exact-old-token'};
        const importedToken = {openai: 'exact-imported-token'};
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken, ak: 'exact-old-ak'},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sent: Array<{token: Record<string, string>; ak: string}> = [];
        const sendMessage = vi.fn(async (message: {config: Config; baseRevision: number}) => {
            invocation += 1;
            if (invocation === 1) await firstResponseGate;
            const credentials = {token: structuredClone(message.config.token), ak: message.config.ak};
            sent.push(credentials);
            const revision = message.baseRevision + 1;
            storageState.set('local:credentials', credentials);
            storageState.set('local:config', {
                ...sanitizeConfigCredentials(normalizeConfig(message.config)),
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const exactReplacement = configStore.requestConfigSave({
            ...configStore.config,
            token: oldToken,
            ak: 'exact-latest-ak',
        }, sendMessage, {credentialIntent: 'exact'});
        releaseFirstResponse();
        await Promise.all([imported, exactReplacement]);

        expect(configStore.config).toMatchObject({token: oldToken, ak: 'exact-latest-ak'});
        expect(sent).toEqual([
            {token: importedToken, ak: 'exact-old-ak'},
            {token: oldToken, ak: 'exact-latest-ak'},
        ]);
    });

    it('旧 replace 响应不覆盖后续已乐观应用的显式凭据 patch', async () => {
        const oldToken = {openai: 'publish-old-token'};
        const firstToken = {openai: 'publish-first-token'};
        const latestToken = {openai: 'publish-latest-token'};
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        let releaseLatestResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        const latestResponseGate = new Promise<void>(resolve => { releaseLatestResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config;
            baseRevision: number;
        }) => {
            invocation += 1;
            if (invocation === 1) await firstResponseGate;
            if (invocation === 2) await latestResponseGate;
            const revision = message.baseRevision + 1;
            if (Object.prototype.hasOwnProperty.call(message.config, 'token')) {
                storageState.set('local:credentials', {token: structuredClone(message.config.token)});
            }
            storageState.set('local:config', {
                ...canonical,
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const first = configStore.requestConfigSave({...configStore.config, token: firstToken}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const latest = configStore.requestConfigPatch({token: latestToken}, sendMessage);
        expect(configStore.config.token).toEqual(latestToken);
        releaseFirstResponse();
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

        expect(configStore.config.token).toEqual(latestToken);
        releaseLatestResponse();
        await Promise.all([first, latest]);
        expect(configStore.config.token).toEqual(latestToken);
    });

    it('replace 后的公开 patch 即使配置回读失败也不回滚前驱凭据', async () => {
        const oldToken = {openai: 'read-failure-old-token'};
        const importedToken = {openai: 'read-failure-imported-token'};
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: oldToken},
        });
        await configStore.configReady;
        const configWatch = storageWatchers.get('local:config')!;
        let failConfigRead = false;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (failConfigRead && key === 'local:config') throw new Error('config read unavailable');
            return storageState.get(key) ?? null;
        });
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async (_message: {
            mode?: 'replace' | 'patch';
            config: Config | Record<string, unknown>;
            baseRevision: number;
        }) => {
            invocation += 1;
            if (invocation === 1) {
                await firstResponseGate;
                storageState.set('local:credentials', {token: importedToken});
                const committed = {
                    ...canonical,
                    __fluentConfigRevision: 5,
                };
                storageState.set('local:config', committed);
                configWatch(committed);
                return {success: true, revision: 5};
            }
            const committed = {
                ...canonical,
                theme: 'dark',
                __fluentConfigRevision: 6,
            };
            storageState.set('local:config', committed);
            failConfigRead = true;
            return {success: true, revision: 6};
        });

        const imported = configStore.requestConfigSave({
            ...configStore.config,
            token: importedToken,
        }, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const publicPatch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        releaseFirstResponse();
        await Promise.all([imported, publicPatch]);

        expect(configStore.config).toMatchObject({token: importedToken, theme: 'dark'});
    });

    it('失败前驱的乐观字段不会被后继成功 patch 的回读失败 fallback 复活', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            theme: 'auto',
            to: 'zh-Hans',
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
        });
        await configStore.configReady;
        let failConfigRead = false;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (failConfigRead && key === 'local:config') throw new Error('config read unavailable');
            return storageState.get(key) ?? null;
        });
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async () => {
            invocation += 1;
            if (invocation === 1) {
                await firstResponseGate;
                return {success: false, error: 'first patch failed'};
            }
            storageState.set('local:config', {
                ...canonical,
                to: 'ja',
                __fluentConfigRevision: 5,
            });
            failConfigRead = true;
            return {success: true, revision: 5};
        });

        const failedTheme = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const successfulLanguage = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        expect(configStore.config).toMatchObject({theme: 'dark', to: 'ja'});
        releaseFirstResponse();

        const outcomes = await Promise.allSettled([failedTheme, successfulLanguage]);
        expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled']);
        expect(configStore.config).toMatchObject({theme: 'auto', to: 'ja'});
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('后继成功 patch 读到旧 revision 时保留前驱已提交字段', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            theme: 'auto',
            to: 'zh-Hans',
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
        });
        await configStore.configReady;
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async () => {
            invocation += 1;
            if (invocation === 1) {
                await firstResponseGate;
                storageState.set('local:config', {
                    ...canonical,
                    theme: 'dark',
                    __fluentConfigRevision: 5,
                });
                return {success: true, revision: 5};
            }
            // 后台已经把 to patch 提交为 rev6，但这个页面的读取仍命中旧 rev4。
            storageState.set('local:config', {...canonical, __fluentConfigRevision: 4});
            return {success: true, revision: 6};
        });

        const firstTheme = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const secondLanguage = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        releaseFirstResponse();

        await Promise.all([firstTheme, secondLanguage]);
        expect(configStore.config).toMatchObject({theme: 'dark', to: 'ja'});
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('前驱与队尾 patch 都失败且队尾回读失败时不复活前驱乐观字段', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            theme: 'auto',
            to: 'zh-Hans',
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
        });
        await configStore.configReady;
        let failConfigRead = false;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (failConfigRead && key === 'local:config') throw new Error('config read unavailable');
            return storageState.get(key) ?? null;
        });
        let releaseFirstResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async () => {
            invocation += 1;
            if (invocation === 1) {
                await firstResponseGate;
                return {success: false, error: 'first patch failed'};
            }
            failConfigRead = true;
            return {success: false, error: 'tail patch failed'};
        });

        const failedTheme = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const failedLanguage = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        expect(configStore.config).toMatchObject({theme: 'dark', to: 'ja'});
        releaseFirstResponse();

        const outcomes = await Promise.allSettled([failedTheme, failedLanguage]);
        expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
        expect(configStore.config).toMatchObject({theme: 'auto', to: 'zh-Hans'});
        expect(configStore.getConfigRevision()).toBe(4);
    });

    it.each([
        ['成功', false],
        ['网络失败', true],
    ] as const)('相同快照的第一次%s不清除第二次请求所有权', async (_outcome, firstFails) => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        configStore.config.to = 'ja';
        const configWatch = storageWatchers.get('local:config')!;
        let releaseFirstResponse!: () => void;
        let releaseLatestResponse!: () => void;
        const firstResponseGate = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
        const latestResponseGate = new Promise<void>(resolve => { releaseLatestResponse = resolve; });
        let invocation = 0;
        const sendMessage = vi.fn(async (message: {config: Config; baseRevision: number}) => {
            invocation += 1;
            if (invocation === 1) {
                await firstResponseGate;
                if (firstFails) throw new Error('first request unavailable');
            } else {
                await latestResponseGate;
            }
            const revision = firstFails ? 5 : message.baseRevision + 1;
            storageState.set('local:config', {
                ...canonical,
                to: 'ja',
                __fluentConfigRevision: revision,
            });
            return {success: true, revision};
        });

        const first = configStore.requestConfigSave(configStore.config, sendMessage);
        const latest = configStore.requestConfigSave(configStore.config, sendMessage);
        const results = Promise.allSettled([first, latest]);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        releaseFirstResponse();
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        configWatch({
            ...canonical,
            to: 'ko',
            __fluentConfigRevision: firstFails ? 4 : 5,
        });

        expect(configStore.config.to).toBe('ja');
        releaseLatestResponse();
        const settled = await results;
        expect(settled.map(result => result.status)).toEqual(
            firstFails ? ['rejected', 'fulfilled'] : ['fulfilled', 'fulfilled'],
        );
        expect(configStore.config.to).toBe('ja');
    });

    it('翻译计数使用同 revision 的原子增量，不生成用户配置历史版本', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, count: 10, __fluentConfigRevision: 4});
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        const historyBefore = configStore.getConfigHistorySnapshot();

        await expect(configStore.incrementConfigCount(3, 'count-operation-1')).resolves.toBe(13);
        await expect(configStore.incrementConfigCount(3, 'count-operation-1')).resolves.toBe(13);

        expect(configStore.config.count).toBe(13);
        expect(storageState.get('local:config')).toMatchObject({
            count: 13,
            __fluentConfigRevision: 4,
            __fluentCountOperations: [{id: 'count-operation-1', delta: 3, count: 13}],
        });
        expect(configStore.getConfigRevision()).toBe(4);
        expect(configStore.getConfigHistorySnapshot()).toEqual(historyBefore);
        await expect(configStore.incrementConfigCount(0)).rejects.toThrow('无效的翻译计数增量');
        await expect(configStore.incrementConfigCount(1, 'count-operation-1'))
            .rejects.toThrow('操作标识与增量不一致');

        await configStore.saveConfig({...configStore.config, count: 1, to: 'en'}, {
            recordHistory: true,
            immediateHistory: true,
        });
        expect(configStore.config.count).toBe(13);
        expect(storageState.get('local:config')).toMatchObject({count: 13, to: 'en'});

        const persistedAfterSave = structuredClone(storageState.get('local:config'));
        const restartedStore = await loadConfigModule(persistedAfterSave);
        await restartedStore.configReady;
        storageMock.setItem.mockClear();
        await expect(restartedStore.incrementConfigCount(3, 'count-operation-1')).resolves.toBe(13);
        expect(restartedStore.config.count).toBe(13);
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it.each([
        ['旧 session 读取', {failSessionRead: true}],
        ['local 检查点写入', {failLocalCredentialWrite: true}],
    ] as const)('后台重启后%s失败仍先水合计数操作日志', async (_failure, failureOptions) => {
        let releaseConfigRead!: () => void;
        const configReadBarrier = new Promise<void>((resolve) => { releaseConfigRead = resolve; });
        const secret = 'count-restart-session-secret';
        const persisted = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            token: {openai: secret},
            persistCredentials: false,
            count: 13,
            __fluentConfigRevision: 4,
            __fluentCountOperations: [{id: 'count-restart-operation', delta: 3, count: 13}],
        };
        const restartedStore = await loadConfigModule(persisted, {...failureOptions, configReadBarrier});
        const retry = restartedStore.incrementConfigCount(3, 'count-restart-operation');

        releaseConfigRead();
        await expect(retry).resolves.toBe(13);
        await expect(restartedStore.configReady).resolves.toBeUndefined();

        expect(restartedStore.config.count).toBe(13);
        expect(storageMock.setItem.mock.calls.filter(([key]) => key === 'local:config')).toHaveLength(0);
        expect(storageState.get('local:config')).toEqual(persisted);
        expect(restartedStore.config.token.openai).toBe(secret);
        await expect(restartedStore.incrementConfigCount(1, 'count-new-operation'))
            .rejects.toThrow('配置安全迁移未完成');
        expect(storageState.get('local:config')).toEqual(persisted);
    });

    it('凭据载体读取失败时保留已读取的公开配置并禁止覆盖旧存储', async () => {
        const secret = 'unread-local-credential-secret';
        const persisted = {
            ...sanitizeConfigCredentials(normalizeConfig({...storedConfig, to: 'ja'})),
            token: {openai: secret},
            count: 21,
            __fluentConfigRevision: 7,
            __fluentCountOperations: [{id: 'count-before-credential-read-failure', delta: 1, count: 21}],
        };
        const configStore = await loadConfigModule(persisted, {failLocalCredentialRead: true});

        await expect(configStore.configReady).resolves.toBeUndefined();
        expect(configStore.config).toMatchObject({to: 'ja', count: 21});
        expect(configStore.config.token).toEqual({});
        await expect(configStore.prepareHydratedConfigForExport())
            .rejects.toThrow('配置或凭据安全水合未完成，无法导出完整备份');
        await expect(configStore.incrementConfigCount(1, 'count-after-credential-read-failure'))
            .rejects.toThrow('配置安全迁移未完成');
        await expect(configStore.saveConfig({...configStore.config, to: 'ko'}))
            .rejects.toThrow('配置安全迁移未完成');
        expect(storageState.get('local:config')).toEqual(persisted);
        expect(storageMock.removeItem).not.toHaveBeenCalled();
    });

    it('计数增量请求只发送 delta，并校验后台响应', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const sendMessage = vi.fn().mockResolvedValue({success: true, count: 7});

        await expect(configStore.requestConfigCountIncrement(2, sendMessage, 'count-request-1')).resolves.toBe(7);
        expect(sendMessage).toHaveBeenCalledWith({
            type: 'incrementConfigCount',
            delta: 2,
            operationId: 'count-request-1',
        });
        await expect(configStore.requestConfigCountIncrement(0, sendMessage, 'count-request-2'))
            .rejects.toThrow('无效的翻译计数增量');
        await expect(configStore.requestConfigCountIncrement(1, vi.fn().mockResolvedValue({success: false, error: 'failed'}), 'count-request-3'))
            .rejects.toThrow('failed');
        await expect(configStore.requestConfigCountIncrement(1, vi.fn().mockResolvedValue({success: true}), 'count-request-4'))
            .rejects.toThrow('没有返回结果');
    });

    it('计数累加拒绝运行时畸形值和安全整数溢出，失败时不写存储', async () => {
        const configStore = await loadConfigModule({...storedConfig, count: Number.MAX_SAFE_INTEGER});
        await configStore.configReady;
        storageMock.setItem.mockClear();

        await expect(configStore.incrementConfigCount(1, 'count-overflow-operation'))
            .rejects.toThrow('超过安全整数范围');
        expect(configStore.config.count).toBe(Number.MAX_SAFE_INTEGER);
        expect(storageMock.setItem).not.toHaveBeenCalled();

        configStore.config.count = -1;
        await expect(configStore.incrementConfigCount(1, 'count-invalid-current-operation'))
            .rejects.toThrow('不是非负安全整数');
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it('后台拒绝旧 revision 时重新读取最新配置，而不是保留会再次覆盖的旧快照', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const sendMessage = vi.fn().mockImplementation(async () => {
            storageState.set('local:config', {...canonical, to: 'ja', __fluentConfigRevision: 5});
            return {success: false, error: '配置已更新（当前 revision 5）'};
        });

        await expect(configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage))
            .rejects.toThrow('当前 revision 5');

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({baseRevision: 4}));
        expect(configStore.config.to).toBe('ja');
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('local config 写入失败不提前发布 revision，随后可以从原版本重试', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        let failNextConfigWrite = true;
        storageMock.setItem.mockImplementation(async (key: string, nextValue: unknown) => {
            storageOperations.push(`set:${key}`);
            if (key === 'local:config' && failNextConfigWrite) {
                failNextConfigWrite = false;
                throw new Error('temporary local storage failure');
            }
            storageState.set(key, structuredClone(nextValue));
        });

        await expect(configStore.saveConfig({...configStore.config, to: 'en'}))
            .rejects.toThrow('temporary local storage failure');
        expect(configStore.getConfigRevision()).toBe(4);
        expect(storageState.get('local:config')).toMatchObject({to: 'zh-Hans', __fluentConfigRevision: 4});

        await expect(configStore.saveConfig({...configStore.config, to: 'ja'})).resolves.toBeUndefined();
        expect(configStore.getConfigRevision()).toBe(5);
        expect(storageState.get('local:config')).toMatchObject({to: 'ja', __fluentConfigRevision: 5});
    });

    it('发送响应式配置时先转换为 Firefox 可结构化克隆的纯对象', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const sendMessage = vi.fn(async ({baseRevision}: {baseRevision: number; config: Config}) => ({
            success: true,
            revision: baseRevision + 1,
        }));
        const reactiveConfig = reactive({
            ...configStore.config,
            to: 'ja',
            model: reactive({ openai: 'gpt-4o-mini' }),
        });

        await configStore.requestConfigSave(reactiveConfig, sendMessage);

        const sentConfig = sendMessage.mock.calls[0][0].config;
        expect(() => structuredClone(sentConfig)).not.toThrow();
        expect(sentConfig).toMatchObject({
            to: 'ja',
            model: {openai: customModelString},
            customModel: {openai: 'gpt-4o-mini'},
            customModels: {openai: expect.arrayContaining(['gpt-4o-mini'])},
        });
    });

    it('后台不可用时失败关闭，不在短生命周期上下文降级落盘', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        storageMock.setItem.mockClear();
        const sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));

        await expect(configStore.requestConfigSave({ ...configStore.config, to: 'ja' }, sendMessage))
            .rejects.toThrow('Receiving end does not exist');
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });

    it('content 保存公开字段时保留后台运行时凭据并忽略旧持久化策略字段', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const current = normalizeConfig({
            ...configStore.config,
            token: {openai: 'background-session-secret'},
            extra: {zhipu: {jwt: 'derived-secret'}},
            persistCredentials: true,
            count: 42,
            videoServiceDefaultMigrated: true,
        });
        const contentSnapshot = normalizeConfig({
            ...current,
            to: 'ja',
            token: {},
            extra: {},
            persistCredentials: false,
            count: 1,
            videoServiceDefaultMigrated: false,
        });

        const prepared = configStore.prepareConfigSaveRequest(contentSnapshot, current, false);
        const extensionPrepared = configStore.prepareConfigSaveRequest(contentSnapshot, current, true);

        expect(prepared).toMatchObject({
            to: 'ja',
            token: {openai: 'background-session-secret'},
            extra: {zhipu: {jwt: 'derived-secret'}},
            count: 42,
            videoServiceDefaultMigrated: true,
        });
        expect(prepared).not.toHaveProperty('persistCredentials');
        expect(extensionPrepared.token).toEqual({});
        expect(extensionPrepared.extra).toEqual({});
        expect(extensionPrepared).not.toHaveProperty('persistCredentials');
        expect(extensionPrepared.count).toBe(42);
        expect(extensionPrepared.videoServiceDefaultMigrated).toBe(true);
    });

    it('字段补丁只接受已知目标字段，并保留最新配置、统计、迁移状态与 content 凭据边界', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const current = normalizeConfig({
            ...configStore.config,
            to: 'ja',
            theme: 'dark',
            videoTranslationEnabled: true,
            videoSubtitleVisible: true,
            count: 42,
            token: {openai: 'background-secret'},
            futureNonSensitiveSetting: {enabled: true},
        });

        const contentPrepared = configStore.prepareConfigPatchRequest({
            videoSubtitleVisible: false,
            count: 0,
            videoServiceDefaultMigrated: false,
            token: {openai: 'content-stale-secret'},
            unknownFutureToggle: true,
        }, {
            videoSubtitleVisible: true,
        }, current, false);
        const extensionPrepared = configStore.prepareConfigPatchRequest({
            token: {openai: 'new-extension-secret'},
        }, {
            token: {openai: 'background-secret'},
        }, current, true);

        expect(contentPrepared).toMatchObject({
            to: 'ja',
            theme: 'dark',
            videoTranslationEnabled: true,
            videoSubtitleVisible: false,
            count: 42,
            videoServiceDefaultMigrated: true,
            token: {openai: 'background-secret'},
        });
        expect(contentPrepared).not.toHaveProperty('unknownFutureToggle');
        expect(contentPrepared).toHaveProperty('futureNonSensitiveSetting', {enabled: true});
        expect(extensionPrepared.token).toEqual({openai: 'new-extension-secret'});
        expect(extensionPrepared.count).toBe(42);
        expect(() => configStore.prepareConfigPatchRequest({
            videoSubtitleVisible: false,
        }, {
            videoSubtitleVisible: false,
        }, current, false)).toThrow('videoSubtitleVisible');
        expect(() => configStore.prepareConfigPatchRequest({
            videoSubtitleVisible: true,
        }, {
            videoSubtitleVisible: false,
        }, current, false)).toThrow('videoSubtitleVisible');
    });

    it('endpoint/proxy patch 按真实目的地解绑旧 token，并让 proxy 遮蔽的 endpoint 编辑保留凭据', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const service = 'custom:destination-test';
        const provider = {
            id: service,
            name: 'Destination Test',
            endpoint: 'https://old-endpoint.example/v1/chat/completions',
            models: ['model-a'],
        };
        const current = normalizeConfig({
            ...configStore.config,
            customOpenAIProviders: [provider],
            model: {...configStore.config.model, [service]: 'model-a'},
            documentModel: {...configStore.config.documentModel, [service]: 'model-a'},
            token: {[service]: 'old-destination-secret'},
            proxy: {},
        });
        const changedProvider = [{
            ...provider,
            endpoint: 'https://new-endpoint.example/v1/chat/completions',
        }];

        const endpointChanged = configStore.prepareConfigPatchRequest({
            customOpenAIProviders: changedProvider,
        }, {
            customOpenAIProviders: current.customOpenAIProviders,
        }, current, true);
        expect(endpointChanged.token).toEqual({});

        const explicitRotation = configStore.prepareConfigPatchRequest({
            customOpenAIProviders: changedProvider,
            token: {[service]: 'new-destination-secret'},
        }, {
            customOpenAIProviders: current.customOpenAIProviders,
            token: current.token,
        }, current, true);
        expect(explicitRotation.token).toEqual({[service]: 'new-destination-secret'});

        const proxied = normalizeConfig({
            ...current,
            proxy: {[service]: 'https://stable-proxy.example/v1/chat/completions'},
        });
        const maskedEndpointChange = configStore.prepareConfigPatchRequest({
            customOpenAIProviders: changedProvider,
        }, {
            customOpenAIProviders: proxied.customOpenAIProviders,
        }, proxied, true);
        expect(maskedEndpointChange.token).toEqual({[service]: 'old-destination-secret'});

        const proxyChanged = configStore.prepareConfigPatchRequest({
            proxy: {[service]: 'https://next-proxy.example/v1/chat/completions'},
        }, {
            proxy: proxied.proxy,
        }, proxied, true);
        expect(proxyChanged.token).toEqual({});

        const untrustedEndpointChange = configStore.prepareConfigPatchRequest({
            customOpenAIProviders: changedProvider,
        }, {
            customOpenAIProviders: current.customOpenAIProviders,
        }, current, false);
        expect(untrustedEndpointChange.token).toEqual({[service]: 'old-destination-secret'});
    });

    it('日常 destination patch 把派生 token 清理及其 CAS 基线发送给后台', async () => {
        const service = 'custom:wire-destination';
        const provider = {
            id: service,
            name: 'Wire Destination',
            endpoint: 'https://wire-endpoint.example/v1/chat/completions',
            models: ['wire-model'],
        };
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            customOpenAIProviders: [provider],
            model: {[service]: 'wire-model'},
            documentModel: {[service]: 'wire-model'},
            proxy: {[service]: 'https://old-proxy.example/v1/chat/completions'},
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: {[service]: 'wire-secret'}},
        });
        await configStore.configReady;
        const sendMessage = vi.fn(async () => ({success: true, revision: 5}));

        await configStore.requestConfigPatch({
            proxy: {[service]: 'https://new-proxy.example/v1/chat/completions'},
        }, sendMessage);

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'patch',
            config: {
                proxy: {[service]: 'https://new-proxy.example/v1/chat/completions'},
                token: {},
            },
            expected: {
                proxy: {[service]: 'https://old-proxy.example/v1/chat/completions'},
                token: {[service]: 'wire-secret'},
            },
        }));
        expect(configStore.config.token).toEqual({});
    });

    it('日常腾讯 proxy patch 把共享密钥成对清理及其 CAS 基线发送给后台', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            proxy: {[services.tencent]: 'https://old-tmt-proxy.example/'},
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {
                tencentSecretId: 'wire-tencent-id',
                tencentSecretKey: 'wire-tencent-key',
            },
        });
        await configStore.configReady;
        const sendMessage = vi.fn(async () => ({success: true, revision: 5}));

        await configStore.requestConfigPatch({
            proxy: {[services.tencent]: 'https://new-tmt-proxy.example/'},
        }, sendMessage);

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'patch',
            config: {
                proxy: {[services.tencent]: 'https://new-tmt-proxy.example/'},
                tencentSecretId: '',
                tencentSecretKey: '',
            },
            expected: {
                proxy: {[services.tencent]: 'https://old-tmt-proxy.example/'},
                tencentSecretId: 'wire-tencent-id',
                tencentSecretKey: 'wire-tencent-key',
            },
        }));
        expect(configStore.config).toMatchObject({tencentSecretId: '', tencentSecretKey: ''});
    });

    it('destination 派生解绑只拥有目标 service，不覆盖响应前 watch 更新的其他 token', async () => {
        const service = 'custom:owned-token-a';
        const provider = {
            id: service,
            name: 'Owned Token A',
            endpoint: 'https://old-a.example/v1/chat/completions',
            models: ['model-a'],
        };
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            customOpenAIProviders: [provider],
            model: {[service]: 'model-a'},
            documentModel: {[service]: 'model-a'},
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: {[service]: 'a-old', openai: 'b-old'}},
        });
        await configStore.configReady;
        const credentialWatch = storageWatchers.get('local:credentials')!;
        let markCommitted!: () => void;
        let releaseResponse!: () => void;
        const committed = new Promise<void>(resolve => { markCommitted = resolve; });
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        const sendMessage = vi.fn(async (message: {config: Config}) => {
            storageState.set('local:credentials', {token: {openai: 'b-old'}});
            storageState.set('local:config', {
                ...canonical,
                ...sanitizeConfigCredentials(message.config),
                __fluentConfigRevision: 5,
            });
            markCommitted();
            await responseGate;
            return {success: true, revision: 5};
        });

        const request = configStore.requestConfigPatch({
            customOpenAIProviders: [{
                ...provider,
                endpoint: 'https://new-a.example/v1/chat/completions',
            }],
        }, sendMessage);
        await committed;
        const watchedCredentials = {token: {[service]: 'a-old', openai: 'b-new'}};
        storageState.set('local:credentials', watchedCredentials);
        credentialWatch(watchedCredentials);
        releaseResponse();
        await request;

        expect(configStore.config.token).toEqual({openai: 'b-new'});
        expect((await configStore.prepareHydratedConfigForExport()).token).toEqual({openai: 'b-new'});
    });

    it('changed-fields replace 只拥有发生变化的 token service，exact 语义仍单独保留', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
            localCredentials: {token: {openai: 'a-old', deepseek: 'b-old'}},
        });
        await configStore.configReady;
        const credentialWatch = storageWatchers.get('local:credentials')!;
        let markCommitted!: () => void;
        let releaseResponse!: () => void;
        const committed = new Promise<void>(resolve => { markCommitted = resolve; });
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        const sendMessage = vi.fn(async (message: {config: Config}) => {
            storageState.set('local:credentials', {token: structuredClone(message.config.token)});
            storageState.set('local:config', {...canonical, __fluentConfigRevision: 5});
            markCommitted();
            await responseGate;
            return {success: true, revision: 5};
        });

        const request = configStore.requestConfigSave({
            ...configStore.config,
            token: {openai: 'a-new', deepseek: 'b-old'},
        }, sendMessage);
        await committed;
        const watchedCredentials = {token: {openai: 'a-new', deepseek: 'b-new'}};
        storageState.set('local:credentials', watchedCredentials);
        credentialWatch(watchedCredentials);
        releaseResponse();
        await request;

        expect(configStore.config.token).toEqual({openai: 'a-new', deepseek: 'b-new'});
    });

    it('成功响应回读失败时消费等待期间 deferred 的更高 revision', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
        });
        await configStore.configReady;
        const configWatch = storageWatchers.get('local:config')!;
        let rejectRead!: (reason?: unknown) => void;
        let markReadStarted!: () => void;
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        let blockNextConfigRead = false;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (key === 'local:config' && blockNextConfigRead) {
                markReadStarted();
                return new Promise<never>((_resolve, reject) => { rejectRead = reject; });
            }
            return storageState.get(key) ?? null;
        });
        const sendMessage = vi.fn(async () => {
            blockNextConfigRead = true;
            return {success: true, revision: 5};
        });

        const request = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await readStarted;
        const external = {...canonical, to: 'ja', __fluentConfigRevision: 6};
        storageState.set('local:config', external);
        configWatch(external);
        rejectRead(new Error('config read unavailable'));

        await expect(request).rejects.toThrow('配置已由其他页面更新');
        expect(configStore.config).toMatchObject({theme: 'auto', to: 'ja'});
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('失败请求回读失败时同样消费等待期间 deferred 的权威快照', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, theme: 'auto'}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            writeOwner: false,
        });
        await configStore.configReady;
        const configWatch = storageWatchers.get('local:config')!;
        let rejectRead!: (reason?: unknown) => void;
        let markReadStarted!: () => void;
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        let blockNextConfigRead = false;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (key === 'local:config' && blockNextConfigRead) {
                markReadStarted();
                return new Promise<never>((_resolve, reject) => { rejectRead = reject; });
            }
            return storageState.get(key) ?? null;
        });
        const sendMessage = vi.fn(async () => {
            blockNextConfigRead = true;
            return {success: false, error: 'patch rejected'};
        });

        const request = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        await readStarted;
        const external = {...canonical, to: 'ja', __fluentConfigRevision: 5};
        storageState.set('local:config', external);
        configWatch(external);
        rejectRead(new Error('config read unavailable'));

        await expect(request).rejects.toThrow('patch rejected');
        expect(configStore.config).toMatchObject({theme: 'auto', to: 'ja'});
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('字段补丁先乐观更新，后台失败后回读权威快照并自动回滚', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            videoTranslationEnabled: false,
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const sendMessage = vi.fn(async (message: {
            mode?: string;
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            expect(configStore.config.videoTranslationEnabled).toBe(true);
            expect(message).toMatchObject({
                mode: 'patch',
                config: {videoTranslationEnabled: true},
                expected: {videoTranslationEnabled: false},
                baseRevision: 4,
            });
            return {success: false, error: 'patch failed'};
        });

        await expect(configStore.requestConfigPatch({
            videoTranslationEnabled: true,
            unknownFutureToggle: true,
        }, sendMessage)).rejects.toThrow('patch failed');

        expect(configStore.config.videoTranslationEnabled).toBe(false);
        expect(configStore.getConfigRevision()).toBe(4);
        expect(configStore.config).not.toHaveProperty('unknownFutureToggle');
    });

    it('字段补丁确认回声不重复 apply 或通知订阅者', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({
            ...storedConfig,
            videoTranslationEnabled: false,
        }));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const listener = vi.fn();
        const unsubscribe = configStore.subscribeConfig(listener);
        listener.mockClear();
        const sendMessage = vi.fn(async () => {
            expect(configStore.config.videoTranslationEnabled).toBe(true);
            expect(listener).toHaveBeenCalledOnce();
            const committed = {
                ...canonical,
                videoTranslationEnabled: true,
                __fluentConfigRevision: 5,
            };
            storageState.set('local:config', committed);
            storageWatchers.get('local:config')!(committed);
            return {success: true, revision: 5};
        });

        await configStore.requestConfigPatch({videoTranslationEnabled: true}, sendMessage);

        expect(configStore.config.videoTranslationEnabled).toBe(true);
        expect(configStore.getConfigRevision()).toBe(5);
        expect(listener).toHaveBeenCalledOnce();
        unsubscribe();
    });

    it('字段补丁接受并持久化内置服务的自定义模型列表', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const savedModels = {grok: ['private-a', 'private-b']};
        const sendMessage = vi.fn(async (message: {
            mode?: string;
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            expect(message).toMatchObject({
                mode: 'patch',
                config: {customModels: savedModels},
                expected: {customModels: {}},
                baseRevision: 4,
            });
            const committed = {...canonical, customModels: savedModels, __fluentConfigRevision: 5};
            storageState.set('local:config', committed);
            storageWatchers.get('local:config')!(committed);
            return {success: true, revision: 5};
        });

        await configStore.requestConfigPatch({customModels: savedModels}, sendMessage);
        expect(configStore.config.customModels).toEqual(savedModels);
    });

    it('字段补丁冲突后回读同字段的权威新值', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const sendMessage = vi.fn(async (message: {
            mode?: string;
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            expect(configStore.config.to).toBe('ja');
            expect(message).toMatchObject({
                mode: 'patch',
                config: {to: 'ja'},
                expected: {to: 'zh-Hans'},
                baseRevision: 4,
            });
            storageState.set('local:config', {
                ...canonical,
                to: 'ko',
                __fluentConfigRevision: 5,
            });
            return {success: false, error: '配置字段已更新，请同步后重试：to'};
        });

        await expect(configStore.requestConfigPatch({to: 'ja'}, sendMessage))
            .rejects.toThrow('to');

        expect(configStore.config.to).toBe('ko');
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('先写入并读回 local 凭据，再清理旧 config/history 明文', async () => {
        const secret = 'legacy-secret-sentinel';
        const legacyConfig = {
            ...storedConfig,
            token: {openai: secret},
            ak: `${secret}-ak`,
            extra: {jwt: `${secret}-jwt`},
        };
        const legacyHistory = {
            schemaVersion: 1,
            entries: [{version: 1, savedAt: new Date(0).toISOString(), config: legacyConfig}],
            cursor: 0,
            nextVersion: 2,
        };
        const configStore = await loadConfigModule(legacyConfig, {history: legacyHistory});

        await configStore.configReady;

        const setLocal = storageOperations.indexOf('set:local:credentials');
        const verifyLocal = storageOperations.indexOf('get:local:credentials', setLocal + 1);
        const setConfig = storageOperations.indexOf('set:local:config');
        const setHistory = storageOperations.indexOf('set:local:configHistory');
        expect(setLocal).toBeGreaterThan(-1);
        expect(verifyLocal).toBeGreaterThan(setLocal);
        expect(setHistory).toBeGreaterThan(verifyLocal);
        expect(setConfig).toBeGreaterThan(setHistory);
        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: secret}});
        expect(storageState.has('session:credentials')).toBe(false);
        expect(JSON.stringify(storageState.get('local:config'))).not.toContain(secret);
        expect(JSON.stringify(storageState.get('local:configHistory'))).not.toContain(secret);
    });

    it('损坏的旧历史字符串可能包含凭据时直接丢弃，不能把敏感片段原样写回', async () => {
        const secret = 'malformed-history-secret-sentinel';
        const legacyConfig = {...storedConfig, token: {openai: secret}};
        const malformedHistory = `{"entries":[{"config":{"token":{"openai":"${secret}"}}}`;
        const configStore = await loadConfigModule(legacyConfig, {history: malformedHistory});

        await configStore.configReady;

        expect(storageState.has('local:configHistory')).toBe(false);
        expect(JSON.stringify([...storageState.values()])).not.toContain(malformedHistory);
        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: secret}});
    });

    it('默认把新凭据加密持久保存到 local，公开配置与历史不含敏感 sentinel', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        const secret = 'persistent-secret-sentinel';

        await configStore.saveConfig({
            ...configStore.config,
            token: {openai: secret},
            to: 'en',
        }, {recordHistory: true, immediateHistory: true});

        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: secret}});
        expect(storageState.has('session:credentials')).toBe(false);
        expect(JSON.stringify(storageState.get('local:config'))).not.toContain(secret);
        expect(JSON.stringify(storageState.get('local:configHistory'))).not.toContain(secret);
        const persistedConfig = storageState.get('local:config') as Record<string, unknown>;
        expect(persistedConfig.token).toBeUndefined();
        expect(persistedConfig.extra).toBeUndefined();

        await configStore.saveConfig({...configStore.config, token: {}, to: 'ja'});
        expect(storageState.get('local:credentials')).toMatchObject({token: {}});
    });

    it('扩展后台用一次原子提交写入持久凭据与公开配置，并清理旧 session', async () => {
        const oldSecret = 'atomic-old-secret';
        const newSecret = 'atomic-new-secret';
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            atomicSetItems: true,
            localCredentials: {token: {openai: oldSecret}},
        });
        await configStore.configReady;
        storageState.set('session:credentials', {token: {openai: 'stale-session-secret'}});

        await configStore.saveConfig({...configStore.config, token: {openai: newSecret}, to: 'en'});

        expect(atomicSetItemsMock).toHaveBeenCalledTimes(1);
        const [entries, removeKeys] = atomicSetItemsMock.mock.calls[0] as [Map<string, unknown>, string[]];
        expect([...entries.keys()].sort()).toEqual(['local:config', 'local:credentials']);
        expect(entries.get('local:credentials')).toMatchObject({token: {openai: newSecret}});
        expect(JSON.stringify(entries.get('local:config'))).not.toContain(newSecret);
        expect(removeKeys).toEqual(['session:credentials']);
        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: newSecret}});
        expect(storageState.has('session:credentials')).toBe(false);
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('原子提交失败时不改变 IndexedDB 快照或推进持久 revision', async () => {
        const oldSecret = 'atomic-preserved-secret';
        const canonicalConfig = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonicalConfig, {
            atomicSetItems: true,
            failAtomicCommit: true,
            localCredentials: {token: {openai: oldSecret}},
        });
        await configStore.configReady;

        await expect(configStore.saveConfig({
            ...configStore.config,
            token: {openai: 'atomic-rejected-secret'},
            to: 'en',
        })).rejects.toThrow('atomic commit unavailable');

        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: oldSecret}});
        expect(storageState.get('local:config')).toEqual(canonicalConfig);
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('旧策略双副本不一致时采用最新 session，验证 local 后删除 session 与旧字段', async () => {
        const configStore = await loadConfigModule({...storedConfig, persistCredentials: false}, {
            localCredentials: {token: {openai: 'old-local-secret'}},
            sessionCredentials: {token: {openai: 'new-session-secret'}},
        });

        await configStore.configReady;

        expect(configStore.config.token.openai).toBe('new-session-secret');
        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: 'new-session-secret'}});
        expect(storageState.has('session:credentials')).toBe(false);
        expect(storageState.get('local:config')).not.toHaveProperty('persistCredentials');
        const setLocal = storageOperations.indexOf('set:local:credentials');
        const verifyLocal = storageOperations.indexOf('get:local:credentials', setLocal + 1);
        const removeSession = storageOperations.indexOf('remove:session:credentials');
        const setConfig = storageOperations.indexOf('set:local:config');
        expect(verifyLocal).toBeGreaterThan(setLocal);
        expect(removeSession).toBeGreaterThan(verifyLocal);
        expect(setConfig).toBeGreaterThan(removeSession);
    });

    it('新配置以 local 凭据为权威，不被残留旧 session 回滚', async () => {
        const canonical = {
            ...sanitizeConfigCredentials(normalizeConfig(storedConfig)),
            __fluentConfigRevision: 5,
        };
        const configStore = await loadConfigModule(canonical, {
            localCredentials: {token: {openai: 'new-local-secret'}},
            sessionCredentials: {token: {openai: 'stale-session-secret'}},
        });

        await configStore.configReady;

        expect(configStore.config.token.openai).toBe('new-local-secret');
        expect(storageState.get('local:credentials')).toMatchObject({token: {openai: 'new-local-secret'}});
        expect(storageState.has('session:credentials')).toBe(false);
    });

    it('恢复历史只恢复可恢复字段，并保留当前凭据、统计和迁移标记', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        await configStore.saveConfig({...configStore.config, to: 'en'}, {recordHistory: true, immediateHistory: true});
        const baselineVersion = configStore.getConfigHistorySnapshot().entries[0].version;
        const secret = 'restore-secret-sentinel';
        await configStore.incrementConfigCount(42, 'history-restore-count-operation');
        await configStore.saveConfig({
            ...configStore.config,
            token: {openai: secret},
            count: 1,
            videoServiceDefaultMigrated: true,
            to: 'ja',
        }, {recordHistory: true, immediateHistory: true});

        await configStore.applyConfigHistoryAction('restore', baselineVersion);

        expect(configStore.config.to).toBe('zh-Hans');
        expect(configStore.config.token.openai).toBe(secret);
        expect(configStore.config).not.toHaveProperty('persistCredentials');
        expect(configStore.config.count).toBe(42);
        expect(configStore.config.videoServiceDefaultMigrated).toBe(true);
        expect(JSON.stringify(configStore.getConfigHistorySnapshot())).not.toContain(secret);
        expect(configStore.getConfigHistorySnapshot().entries.every((entry) => (
            !('count' in entry.config)
            && !('persistCredentials' in entry.config)
            && !('videoServiceDefaultMigrated' in entry.config)
        ))).toBe(true);
    });

    it.each([
        ['写入', {failLocalCredentialWrite: true}],
        ['读回校验', {failLocalCredentialVerification: true}],
    ] as const)('local 凭据%s失败时不删除或改写旧载体', async (_failure, failureOptions) => {
        const secret = 'must-not-delete-secret';
        const legacyConfig = {...storedConfig, token: {openai: secret}, persistCredentials: false};
        const configStore = await loadConfigModule(legacyConfig, {
            ...failureOptions,
            sessionCredentials: {token: {openai: secret}},
        });

        await expect(configStore.configReady).resolves.toBeUndefined();

        expect(configStore.config.token.openai).toBe(secret);
        expect(storageMock.removeItem).not.toHaveBeenCalled();
        expect(storageMock.setItem).not.toHaveBeenCalledWith('local:config', expect.anything());
        expect(storageState.get('local:config')).toEqual(legacyConfig);
        expect(storageState.get('session:credentials')).toMatchObject({token: {openai: secret}});
    });

    it('网页/content 上下文不访问 session，也不执行危险迁移', async () => {
        const secret = 'content-context-secret';
        const legacyConfig = {...storedConfig, token: {openai: secret}};
        const configStore = await loadConfigModule(legacyConfig, {trusted: false});

        await configStore.configReady;

        expect(configStore.config.token).toEqual({});
        expect(storageOperations.some((operation) => operation.includes(':credentials'))).toBe(false);
        expect(storageMock.setItem).not.toHaveBeenCalled();
        expect(storageMock.removeItem).not.toHaveBeenCalled();
        expect(storageState.get('local:config')).toEqual(legacyConfig);
    });

    it('连续请求按页面顺序串行发送，并让后一次使用前一次提交后的 revision', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const sent: string[] = [];
        let releaseFirst!: () => void;
        const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const baseRevisions: number[] = [];
        const sendMessage = vi.fn(async ({config, baseRevision}: {config: {to: string}; baseRevision: number}) => {
            sent.push(config.to);
            baseRevisions.push(baseRevision);
            if (sent.length === 1) await firstFinished;
            return {success: true, revision: baseRevision + 1};
        });

        const first = configStore.requestConfigSave({ ...configStore.config, to: 'en' }, sendMessage);
        const latest = configStore.requestConfigSave({ ...configStore.config, to: 'ja' }, sendMessage);
        await vi.waitFor(() => expect(sent).toEqual(['en']));
        releaseFirst();
        await Promise.all([first, latest]);

        expect(sent).toEqual(['en', 'ja']);
        expect(baseRevisions).toEqual([1, 2]);
    });

    it('关闭页面前在首个 ACK 被阻塞时同步交接完整 patch 链，后台完成最后一次修改', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const {createConfigPersistenceHandler, createConfigPersistenceBatchHandler} = await import(
            '@/src/app/background/handlers/configPersistence'
        );
        let backgroundConfig = normalizeConfig(canonical);
        let revision = 4;
        let writes = 0;
        const handler = createConfigPersistenceHandler({
            ready: Promise.resolve(),
            getCurrentConfig: () => backgroundConfig,
            getCurrentRevision: () => revision,
            prepareConfigSaveRequest: configStore.prepareConfigSaveRequest,
            prepareConfigPatchRequest: configStore.prepareConfigPatchRequest,
            isExtensionUrl: () => true,
            saveConfig: async next => {
                backgroundConfig = next;
                writes += 1;
                revision += 1;
                storageState.set('local:config', {...sanitizeConfigCredentials(next), __fluentConfigRevision: revision});
            },
        });
        const batchHandler = createConfigPersistenceBatchHandler(handler);
        let releaseFirstAck!: () => void;
        const firstAck = new Promise<void>(resolve => { releaseFirstAck = resolve; });
        const sendMessage = vi.fn(async (message: Parameters<typeof handler.handle>[0]) => {
            const response = await handler.handle(message, {});
            if (message.sequence === 1) await firstAck;
            return response;
        });
        const batchSender = vi.fn(async (message: Parameters<typeof batchHandler.handle>[0]) => batchHandler.handle(message, {}));
        await configStore.handoffPendingConfigPatches(sendMessage, batchSender);
        expect(batchSender).not.toHaveBeenCalled();

        const first = configStore.requestConfigPatch({to: 'en'}, sendMessage);
        await vi.waitFor(() => expect(backgroundConfig.to).toBe('en'));
        const second = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        const third = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);
        const settled = Promise.allSettled([first, second, third]);
        expect(configStore.config).toMatchObject({to: 'ja', theme: 'dark'});
        expect(sendMessage).toHaveBeenCalledOnce();

        const handoff = configStore.handoffPendingConfigPatches(sendMessage, batchSender);
        // 这里没有等待 microtask；信封必须已经跨过即将关闭的页面边界。
        expect(batchSender).toHaveBeenCalledOnce();
        expect(batchSender.mock.calls[0][0]).toMatchObject({
            type: 'persistConfigBatch',
            clientId: sendMessage.mock.calls[0][0].clientId,
            patches: [
                {sequence: 1, config: {to: 'en'}, expected: {to: 'zh-Hans'}},
                {sequence: 2, config: {to: 'ja'}, expected: {to: 'en'}},
                {sequence: 3, config: {theme: 'dark'}, expected: {theme: 'auto'}},
            ],
        });
        await handoff;
        expect(backgroundConfig).toMatchObject({to: 'ja', theme: 'dark'});
        expect(writes).toBe(3);
        // 页面在 pagehide 后仍短暂存活时，重复交接与原队列恢复均沿用同序号去重。
        await configStore.handoffPendingConfigPatches(sendMessage, batchSender);
        expect(writes).toBe(3);
        releaseFirstAck();
        await settled;
        expect(writes).toBe(3);
        expect(configStore.config).toMatchObject({to: 'ja', theme: 'dark'});
        batchSender.mockClear();
        await configStore.handoffPendingConfigPatches(sendMessage, batchSender);
        expect(batchSender).not.toHaveBeenCalled();
    });

    it('设置页真实退出函数同步交接首 ACK 在途的 Harness 最后编辑，重复退出不重写', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, harness: {enabled: false, contextMode: 'paragraph'}}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const {createConfigPersistenceHandler, createConfigPersistenceBatchHandler} = await import(
            '@/src/app/background/handlers/configPersistence'
        );
        let backgroundConfig = normalizeConfig(canonical);
        let revision = 4;
        let writes = 0;
        const handler = createConfigPersistenceHandler({
            ready: Promise.resolve(), getCurrentConfig: () => backgroundConfig, getCurrentRevision: () => revision,
            prepareConfigSaveRequest: configStore.prepareConfigSaveRequest,
            prepareConfigPatchRequest: configStore.prepareConfigPatchRequest,
            isExtensionUrl: () => true,
            saveConfig: async next => {
                backgroundConfig = next; writes += 1; revision += 1;
                storageState.set('local:config', {...sanitizeConfigCredentials(next), __fluentConfigRevision: revision});
            },
        });
        const batchHandler = createConfigPersistenceBatchHandler(handler);
        let releaseFirstAck!: () => void;
        const firstAck = new Promise<void>(resolve => { releaseFirstAck = resolve; });
        const batches: unknown[] = [];
        const sender = vi.fn(async (message: any) => {
            if (message.type === 'persistConfigBatch') {
                batches.push(message);
                return batchHandler.handle(message, {});
            }
            const response = await handler.handle(message, {});
            if (message.sequence === 1) await firstAck;
            return response;
        });
        const draft = {value: normalizeConfig(configStore.config)};
        // 执行生产 SFC 中的函数体，而不是复制关闭算法；后台与配置队列仍使用真实实现。
        const source = readFileSync(resolve(process.cwd(), 'src/features/settings/ui/SettingsSections.vue'), 'utf8');
        const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/u)![1];
        const parsed = ts.createSourceFile('SettingsSections.ts', script, ts.ScriptTarget.ES2022, true);
        const exit = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'persistOnPageExit');
        expect(exit).toBeDefined();
        const exitBody = ts.transpileModule(exit!.getText(parsed), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
        const autosave = parsed.statements.find(statement => ts.isExpressionStatement(statement)
            && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(parsed) === 'watch'
            && statement.expression.arguments[0].getText(parsed).includes('JSON.stringify(config.value)')) as ts.ExpressionStatement;
        const callback = (autosave.expression as ts.CallExpression).arguments[1].getText(parsed);
        const autosaveBody = ts.transpileModule(`const onDraftChange = ${callback};`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
        const warnings = {warn: vi.fn()};
        const createExit = (hydrated: boolean) => new Function(
            'handoffPendingConfigPatches', 'sendConfigMessage', 'persistConfigPatch', 'persistConfigReplace', 'config', 'console', 'normalizeConfig',
            `let hydrated = ${hydrated}; let pageExitSaveStarted = false; let applyingExternalConfig = false; let lastSerialized = JSON.stringify(config.value); ${exitBody}; ${autosaveBody}; return Object.assign(persistOnPageExit, {onDraftChange});`,
        )(
            configStore.handoffPendingConfigPatches, sender,
            (value: unknown) => configStore.requestConfigPatch(value, sender),
            (value: unknown) => configStore.requestConfigSave(value, sender), draft, warnings, normalizeConfig,
        ) as (() => void) & {onDraftChange(serialized: string): void};
        createExit(false)();
        expect(sender).not.toHaveBeenCalled();

        draft.value.harness.enabled = true;
        const first = configStore.requestConfigPatch(draft.value, sender);
        await vi.waitFor(() => expect(backgroundConfig.harness.enabled).toBe(true));
        draft.value.harness.contextMode = 'selection';
        const last = configStore.requestConfigPatch(draft.value, sender);
        const settled = Promise.allSettled([first, last]);
        expect(sender).toHaveBeenCalledOnce();
        const close = createExit(true);
        try {
            close();
            // 关闭函数返回前已经交接，不能依赖尚未释放的页面 ACK 或之后的 microtask。
            expect(batches).toHaveLength(1);
            expect(batches[0]).toMatchObject({type: 'persistConfigBatch', patches: [
                {sequence: 1, config: {harness: {enabled: true, contextMode: 'paragraph'}}},
                {sequence: 2, config: {harness: {enabled: true, contextMode: 'selection'}}},
            ]});
            close();
            expect(batches).toHaveLength(1);
            await vi.waitFor(() => expect(backgroundConfig.harness.contextMode).toBe('selection'));
            expect(writes).toBe(2);
            expect(warnings.warn).not.toHaveBeenCalled();
        } finally {
            releaseFirstAck();
            await settled;
        }
        expect(writes).toBe(2);
        // 同一页面若并未真正离开，后续新草稿必须允许下一轮退出交接。
        draft.value.harness.contextMode = 'paragraph';
        close.onDraftChange(JSON.stringify(draft.value));
        close();
        expect(batches).toHaveLength(2);
        await configStore.waitForConfigPersistenceQueue();
        expect(backgroundConfig.harness.contextMode).toBe('paragraph');
        expect(writes).toBe(3);
        sender.mockClear();
        createExit(true)();
        await configStore.waitForConfigPersistenceQueue();
        expect(sender).not.toHaveBeenCalled();
    });

    it('交接只包含同一 sender 的不可变 patch 信封', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const sender = vi.fn(async () => { await gate; return {success: true, revision: 2}; });
        const otherSender = vi.fn(async () => ({success: true, revision: 3}));
        const batchSender = vi.fn(async (_message: {patches: unknown[]}) => ({success: true, revision: 2}));
        const first = configStore.requestConfigPatch({to: 'en'}, sender);
        const other = configStore.requestConfigPatch({theme: 'dark'}, otherSender);
        const settled = Promise.allSettled([first, other]);
        configStore.config.to = 'ja';
        await configStore.handoffPendingConfigPatches(sender, batchSender);
        expect(batchSender.mock.calls).toHaveLength(1);
        expect(batchSender.mock.calls[0]).toEqual([expect.objectContaining({
            patches: [{sequence: 1, config: {to: 'en'}, expected: {to: 'zh-Hans'}}],
        })]);
        release();
        await settled;
    });

    it('整份替换尚未确认时拒绝把后继 patch 单独交接', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const sender = vi.fn(async () => { await gate; return {success: true, revision: 2}; });
        const batchSender = vi.fn();
        const replace = configStore.requestConfigSave({...configStore.config, to: 'en'}, sender);
        const patch = configStore.requestConfigPatch({theme: 'dark'}, sender);
        const settled = Promise.allSettled([replace, patch]);
        await expect(configStore.handoffPendingConfigPatches(sender, batchSender)).rejects.toThrow('整份替换');
        expect(batchSender).not.toHaveBeenCalled();
        release();
        await settled;
    });

    it('交接不得跨过其他 sender 的前驱而让全局序号吞掉其修改', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const firstSender = vi.fn(async () => { await gate; return {success: true, revision: 2}; });
        const secondSender = vi.fn(async () => ({success: true, revision: 3}));
        const batchSender = vi.fn();
        const first = configStore.requestConfigPatch({theme: 'dark'}, firstSender);
        const second = configStore.requestConfigPatch({to: 'ja'}, secondSender);
        const settled = Promise.allSettled([first, second]);
        await expect(configStore.handoffPendingConfigPatches(secondSender, batchSender)).rejects.toThrow('其他发送方的前驱');
        expect(batchSender).not.toHaveBeenCalled();
        release();
        await settled;
    });

    it.each([
        [undefined, '后台接管配置补丁失败'],
        [{success: false, error: '字段 CAS 冲突'}, '字段 CAS 冲突'],
        [{success: true}, '有效 revision'],
        [{success: true, revision: -1}, '有效 revision'],
        [{success: true, revision: 1.5}, '有效 revision'],
    ] as const)('拒绝不成功的后台交接响应 %j', async (response, expected) => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const sender = vi.fn(async () => { await gate; return {success: true, revision: 2}; });
        const request = configStore.requestConfigPatch({to: 'en'}, sender);
        const settled = Promise.allSettled([request]);
        await expect(configStore.handoffPendingConfigPatches(sender, async () => response)).rejects.toThrow(expected);
        release();
        await settled;
    });

    it('水合尚未完成时不交接排队的请求', async () => {
        let releaseHydration!: () => void;
        const configReadBarrier = new Promise<void>(resolve => { releaseHydration = resolve; });
        const configStore = await loadConfigModule(storedConfig, {configReadBarrier});
        const sender = vi.fn(async () => ({success: true, revision: 2}));
        const batchSender = vi.fn();
        const request = configStore.requestConfigSave({...configStore.config, to: 'en'}, sender);
        const settled = Promise.allSettled([request]);
        await expect(configStore.handoffPendingConfigPatches(sender, batchSender)).rejects.toThrow('安全水合');
        expect(batchSender).not.toHaveBeenCalled();
        releaseHydration();
        await settled;
    });

    it('凭据安全水合失败时不交接乐观补丁', async () => {
        const configStore = await loadConfigModule(storedConfig, {failLocalCredentialRead: true});
        await configStore.configReady;
        const sender = vi.fn(async () => ({success: true, revision: 2}));
        const batchSender = vi.fn();
        const request = configStore.requestConfigPatch({to: 'en'}, sender);
        const settled = Promise.allSettled([request]);
        await expect(configStore.handoffPendingConfigPatches(sender, batchSender)).rejects.toThrow('安全水合');
        expect(batchSender).not.toHaveBeenCalled();
        await settled;
    });

    it('补丁链超过后台批次上限时不发出部分链', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const sender = vi.fn(async () => { await gate; return {success: true, revision: 2}; });
        const batchSender = vi.fn();
        const requests = Array.from({length: 257}, (_, index) => configStore.requestConfigPatch({
            to: index % 2 ? 'ja' : 'en',
        }, sender));
        const settled = Promise.allSettled(requests);
        await expect(configStore.handoffPendingConfigPatches(sender, batchSender)).rejects.toThrow('256');
        expect(batchSender).not.toHaveBeenCalled();
        release();
        await settled;
    });

    it('配置持久化 barrier 等待已排队及等待期间追加的请求', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, videoTranslationEnabled: false}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const configWatch = storageMock.watch.mock.calls[0][1];
        let releaseFirstPatch!: () => void;
        let releaseSecondPatch!: () => void;
        const firstPatchGate = new Promise<void>((resolve) => { releaseFirstPatch = resolve; });
        const secondPatchGate = new Promise<void>((resolve) => { releaseSecondPatch = resolve; });
        const sent: Array<{mode: string; baseRevision: number}> = [];
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            sent.push({mode: message.mode || 'replace', baseRevision: message.baseRevision});
            if (message.mode === 'patch' && 'videoTranslationEnabled' in message.config) {
                await firstPatchGate;
                const committed = {
                    ...canonical,
                    videoTranslationEnabled: true,
                    __fluentConfigRevision: 5,
                };
                storageState.set('local:config', committed);
                configWatch(committed);
                return {success: true, revision: 5};
            }
            if (message.mode === 'patch') {
                await secondPatchGate;
                const committed = {
                    ...canonical,
                    videoTranslationEnabled: true,
                    theme: 'dark',
                    __fluentConfigRevision: 6,
                };
                storageState.set('local:config', committed);
                configWatch(committed);
                return {success: true, revision: 6};
            }

            expect(message.baseRevision).toBe(6);
            const committed = {
                ...canonical,
                videoTranslationEnabled: true,
                theme: 'dark',
                to: 'ja',
                __fluentConfigRevision: 7,
            };
            storageState.set('local:config', committed);
            configWatch(committed);
            return {success: true, revision: 7};
        });

        const firstPatch = configStore.requestConfigPatch({videoTranslationEnabled: true}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        let barrierResolved = false;
        const barrier = configStore.waitForConfigPersistenceQueue().then(() => { barrierResolved = true; });
        const secondPatch = configStore.requestConfigPatch({theme: 'dark'}, sendMessage);

        await Promise.resolve();
        expect(barrierResolved).toBe(false);
        releaseFirstPatch();
        await firstPatch;
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
        expect(barrierResolved).toBe(false);
        releaseSecondPatch();
        await Promise.all([secondPatch, barrier]);

        expect(barrierResolved).toBe(true);
        expect(configStore.getConfigRevision()).toBe(6);
        await configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage);
        expect(sent).toEqual([
            {mode: 'patch', baseRevision: 4},
            {mode: 'patch', baseRevision: 4},
            {mode: 'replace', baseRevision: 6},
        ]);
        expect(configStore.config).toMatchObject({
            to: 'ja',
            theme: 'dark',
            videoTranslationEnabled: true,
        });
        expect(configStore.getConfigRevision()).toBe(7);
    });

    it('字段补丁与整份替换共用请求队列，replace 不继承 patch revision', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        const sent: Array<{mode: string; to: string; sequence: number; baseRevision: number}> = [];
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config;
            sequence: number;
            baseRevision: number;
        }) => {
            sent.push({
                mode: message.mode || 'replace',
                to: String(message.config.to),
                sequence: message.sequence,
                baseRevision: message.baseRevision,
            });
            if (message.mode === 'patch') await patchGate;
            return {success: true, revision: message.baseRevision + 1};
        });

        const patch = configStore.requestConfigPatch({to: 'en'}, sendMessage);
        const replace = configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        releasePatch();
        await Promise.all([patch, replace]);

        expect(sent).toEqual([
            {mode: 'patch', to: 'en', sequence: 1, baseRevision: 1},
            {mode: 'replace', to: 'ja', sequence: 2, baseRevision: 1},
        ]);
    });

    it('排队 replace 不借用已吸收外部字段的 patch revision 覆盖新值', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const configWatch = storageMock.watch.mock.calls[0][1];
        const sent: Array<{mode: string; baseRevision: number}> = [];
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            sent.push({mode: message.mode || 'replace', baseRevision: message.baseRevision});
            if (message.mode === 'patch') {
                expect(message).toMatchObject({
                    config: {to: 'ja'},
                    expected: {to: canonical.to},
                    baseRevision: 4,
                });
                const external = {
                    ...canonical,
                    theme: 'dark',
                    __fluentConfigRevision: 5,
                };
                storageState.set('local:config', external);
                configWatch(external);
                const committed = {
                    ...external,
                    to: 'ja',
                    __fluentConfigRevision: 6,
                };
                storageState.set('local:config', committed);
                configWatch(committed);
                return {success: true, revision: 6};
            }

            expect(message.config).toMatchObject({
                to: 'ja',
                theme: canonical.theme,
            });
            expect(message.baseRevision).toBe(4);
            return {success: false, error: '配置已更新（当前 revision 6）'};
        });

        const patch = configStore.requestConfigPatch({to: 'ja'}, sendMessage);
        // patch 的乐观值 X1 已进入 runtime，但外部 Y1 尚未到达当前上下文。
        const staleReplace = configStore.requestConfigSave(normalizeConfig(configStore.config), sendMessage);
        const [patchResult, replaceResult] = await Promise.allSettled([patch, staleReplace]);

        expect(patchResult.status).toBe('fulfilled');
        expect(replaceResult).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({message: expect.stringContaining('revision 6')}),
        });
        expect(sent).toEqual([
            {mode: 'patch', baseRevision: 4},
            {mode: 'replace', baseRevision: 4},
        ]);
        expect(configStore.config).toMatchObject({to: 'ja', theme: 'dark'});
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('外部 revision 会取消混合队列中的旧 replace，但保留可做字段 CAS 的 patch', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, videoTranslationEnabled: false}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const configWatch = storageMock.watch.mock.calls[0][1];
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            expect(message).toMatchObject({
                mode: 'patch',
                config: {videoTranslationEnabled: true},
                expected: {videoTranslationEnabled: false},
                // patch 的 baseRevision 只是协议兼容字段，后台依赖 expected 做 CAS。
                baseRevision: 4,
            });
            const committed = {
                ...canonical,
                to: 'ko',
                videoTranslationEnabled: true,
                __fluentConfigRevision: 6,
            };
            storageState.set('local:config', committed);
            configWatch(committed);
            return {success: true, revision: 6};
        });

        const staleReplace = configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage);
        const patch = configStore.requestConfigPatch({videoTranslationEnabled: true}, sendMessage);
        const external = {
            ...canonical,
            to: 'ko',
            __fluentConfigRevision: 5,
        };
        storageState.set('local:config', external);
        configWatch(external);

        await expect(staleReplace).rejects.toThrow('根据最新配置重新修改');
        await expect(patch).resolves.toBeUndefined();

        expect(sendMessage).toHaveBeenCalledOnce();
        expect(configStore.config).toMatchObject({
            to: 'ko',
            videoTranslationEnabled: true,
        });
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('active replace 期间 deferred 的外部更新会取消所有旧 replace，但后续 patch 仍可 CAS', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig({...storedConfig, videoTranslationEnabled: false}));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const configWatch = storageMock.watch.mock.calls[0][1];
        let releaseActiveReplace!: () => void;
        const activeReplaceGate = new Promise<void>((resolve) => { releaseActiveReplace = resolve; });
        const sent: Array<{mode: string; to: string; baseRevision: number}> = [];
        const sendMessage = vi.fn(async (message: {
            mode?: 'replace' | 'patch';
            config: Config;
            expected?: Config;
            baseRevision: number;
        }) => {
            sent.push({
                mode: message.mode || 'replace',
                to: String(message.config.to ?? ''),
                baseRevision: message.baseRevision,
            });
            if (message.mode !== 'patch') {
                await activeReplaceGate;
                return {success: true, revision: 5};
            }

            expect(message).toMatchObject({
                mode: 'patch',
                config: {videoTranslationEnabled: true},
                expected: {videoTranslationEnabled: false},
                baseRevision: 4,
            });
            const committed = {
                ...canonical,
                to: 'ko',
                videoTranslationEnabled: true,
                __fluentConfigRevision: 7,
            };
            storageState.set('local:config', committed);
            configWatch(committed);
            return {success: true, revision: 7};
        });

        const activeReplace = configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage);
        await vi.waitFor(() => expect(sent).toEqual([
            {mode: 'replace', to: 'en', baseRevision: 4},
        ]));
        const staleReplace = configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage);
        const patch = configStore.requestConfigPatch({videoTranslationEnabled: true}, sendMessage);
        const external = {
            ...canonical,
            to: 'ko',
            __fluentConfigRevision: 6,
        };
        storageState.set('local:config', external);
        // activeRequestSerialized 存在时先 deferred，待 R0 响应后再判定为更高外部版本。
        configWatch(external);
        releaseActiveReplace();

        await expect(activeReplace).rejects.toThrow('其他页面更新');
        await expect(staleReplace).rejects.toThrow('根据最新配置重新修改');
        await expect(patch).resolves.toBeUndefined();

        expect(sent).toEqual([
            {mode: 'replace', to: 'en', baseRevision: 4},
            {mode: 'patch', to: '', baseRevision: 4},
        ]);
        expect(configStore.config).toMatchObject({
            to: 'ko',
            videoTranslationEnabled: true,
        });
        expect(configStore.getConfigRevision()).toBe(7);
    });

    it('一次 revision 冲突会刷新当前配置并取消已经排队的旧快照', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const sendMessage = vi.fn(async () => {
            storageState.set('local:config', {...canonical, to: 'ko', __fluentConfigRevision: 5});
            return {success: false, error: '配置已更新（当前 revision 5）'};
        });

        const first = configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage);
        const queued = configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage);

        await expect(first).rejects.toThrow('当前 revision 5');
        await expect(queued).rejects.toThrow('根据最新配置重新修改');
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(configStore.config.to).toBe('ko');
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('把后台保留 count 后的 canonical storage 回声识别为本次保存并同步 UI', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const watchCallback = storageMock.watch.mock.calls[0][1];
        const sendMessage = vi.fn(async () => {
            watchCallback({...canonical, to: 'ja', count: 7, __fluentConfigRevision: 5});
            return {success: true, revision: 5};
        });

        await expect(configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage))
            .resolves.toBeUndefined();

        expect(configStore.config).toMatchObject({to: 'ja', count: 7});
        expect(configStore.getConfigRevision()).toBe(5);
    });

    it('响应前收到更高 revision 的外部恢复时采用恢复结果并取消排队快照', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4});
        await configStore.configReady;
        const watchCallback = storageMock.watch.mock.calls[0][1];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const sendMessage = vi.fn(async () => {
            await firstGate;
            return {success: true, revision: 5};
        });

        const first = configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const queued = configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage);
        watchCallback({...canonical, to: 'en', __fluentConfigRevision: 5});
        watchCallback({...canonical, to: 'ko', __fluentConfigRevision: 6});
        releaseFirst();

        await expect(first).rejects.toThrow('其他页面更新');
        await expect(queued).rejects.toThrow('根据最新配置重新修改');
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(configStore.config.to).toBe('ko');
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('外部仅更新 local 凭据并推进 revision 时也会取消携带旧凭据的排队快照', async () => {
        const canonical = sanitizeConfigCredentials(normalizeConfig(storedConfig));
        const configStore = await loadConfigModule({...canonical, __fluentConfigRevision: 4}, {
            localCredentials: {token: {openai: 'old-secret'}},
        });
        await configStore.configReady;
        const configWatch = storageMock.watch.mock.calls[0][1];
        const credentialWatch = storageMock.watch.mock.calls.find(([key]) => key === 'local:credentials')?.[1];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const sendMessage = vi.fn(async () => {
            await firstGate;
            return {success: true, revision: 5};
        });

        const first = configStore.requestConfigSave({...configStore.config, to: 'en'}, sendMessage);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        const queued = configStore.requestConfigSave({...configStore.config, to: 'ja'}, sendMessage);
        configWatch({...canonical, to: 'en', __fluentConfigRevision: 5});
        credentialWatch?.({token: {openai: 'new-secret'}});
        configWatch({...canonical, to: 'en', __fluentConfigRevision: 6});
        releaseFirst();

        await expect(first).rejects.toThrow('其他页面更新');
        await expect(queued).rejects.toThrow('根据最新配置重新修改');
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(configStore.config.token.openai).toBe('new-secret');
        expect(configStore.getConfigRevision()).toBe(6);
    });

    it('本地存在更新请求时忽略旧 storage 回声', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await configStore.configReady;
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const sendMessage = vi.fn(async () => {
            await pending;
            return {success: true, revision: 2};
        });
        const latest = { ...configStore.config, to: 'ja' };
        const request = configStore.requestConfigSave(latest, sendMessage);
        const listener = vi.fn();
        const unsubscribe = configStore.subscribeConfig(listener);
        listener.mockClear();
        const watchCallback = storageMock.watch.mock.calls[0][1];

        watchCallback({ ...storedConfig, to: 'en' }, storedConfig);

        expect(configStore.config.to).toBe('zh-Hans');
        expect(listener).not.toHaveBeenCalled();
        release();
        await request;
        unsubscribe();
    });

    it('迟到的旧版本 storage 快照不会回滚已同步的新版本', async () => {
        const configStore = await loadConfigModule({ ...storedConfig, __fluentConfigRevision: 5 });
        await configStore.configReady;
        const watchCallback = storageMock.watch.mock.calls[0][1];

        watchCallback({ ...storedConfig, to: 'ja', __fluentConfigRevision: 7 }, storedConfig);
        watchCallback({ ...storedConfig, to: 'en', __fluentConfigRevision: 6 }, storedConfig);

        expect(configStore.config.to).toBe('ja');
    });

    it('记录配置版本、时间，并限制为最近十条快照', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);

        for (const to of ['en', 'ja', 'ko', 'fr', 'ru', 'de', 'es', 'it', 'pt', 'ar', 'th']) {
            await configStore.saveConfig({ ...configStore.config, to }, {recordHistory: true, immediateHistory: true});
        }

        const history = configStore.getConfigHistorySnapshot();
        expect(history.entries).toHaveLength(10);
        expect(history.cursor).toBe(9);
        expect(history.entries.at(-1)).toMatchObject({
            version: expect.any(Number),
            savedAt: expect.any(String),
            config: expect.objectContaining({to: 'th'}),
        });
        expect(history.entries.map((entry) => entry.version)).toEqual(
            [...history.entries].sort((left, right) => left.version - right.version).map((entry) => entry.version),
        );
    });

    it('支持撤销、重做和按版本恢复，并保持配置与历史游标一致', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        await configStore.saveConfig({ ...configStore.config, to: 'en' }, {recordHistory: true, immediateHistory: true});
        await configStore.saveConfig({ ...configStore.config, to: 'ja' }, {recordHistory: true, immediateHistory: true});

        const beforeUndo = configStore.getConfigHistorySnapshot();
        const undo = await configStore.applyConfigHistoryAction('undo');
        expect(configStore.config.to).toBe('en');
        expect(undo.cursor).toBe(beforeUndo.cursor - 1);

        const redo = await configStore.applyConfigHistoryAction('redo');
        expect(configStore.config.to).toBe('ja');
        expect(redo.cursor).toBe(beforeUndo.cursor);

        await configStore.applyConfigHistoryAction('undo');
        expect(configStore.config.to).toBe('en');

        const baselineVersion = beforeUndo.entries[0].version;
        const restored = await configStore.applyConfigHistoryAction('restore', baselineVersion);
        expect(configStore.config.to).toBe('zh-Hans');
        expect(restored.cursor).toBe(restored.entries.length - 1);
        expect(restored.entries.at(-1)).toMatchObject({
            version: beforeUndo.nextVersion,
            config: expect.objectContaining({to: 'zh-Hans'}),
        });
        expect(restored.entries.some((entry) => entry.config.to === 'ja')).toBe(true);
    });

    it('在配置历史中保存规范化域名，并能恢复旧配置的空名单', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);

        await configStore.saveConfig({
            ...configStore.config,
            alwaysTranslateDomains: [
                'https://news.bbc.co.uk/world',
                'BBC.CO.UK',
                'https://docs.team.github.io/guide',
            ],
        }, {recordHistory: true, immediateHistory: true});

        expect(configStore.config.alwaysTranslateDomains).toEqual(['bbc.co.uk', 'team.github.io']);
        expect(configStore.getConfigHistorySnapshot().entries.at(-1)?.config.alwaysTranslateDomains)
            .toEqual(['bbc.co.uk', 'team.github.io']);

        await configStore.applyConfigHistoryAction('undo');
        expect(configStore.config.alwaysTranslateDomains).toEqual([]);
    });

    it('配置历史操作优先通过后台消息传递，后台不可用时安全回退', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        const sendMessage = vi.fn().mockResolvedValue({success: true, history: configStore.getConfigHistorySnapshot()});

        await configStore.requestConfigHistoryAction('undo', undefined, sendMessage);

        expect(sendMessage).toHaveBeenCalledWith({
            type: configStore.CONFIG_HISTORY_MESSAGE,
            action: 'undo',
            version: undefined,
        });
    });

    it('快速连续编辑只保留最后一个防抖历史快照', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);

        await configStore.saveConfig({ ...configStore.config, to: 'en' }, {recordHistory: true});
        await configStore.saveConfig({ ...configStore.config, to: 'ja' }, {recordHistory: true});
        await configStore.flushConfigHistory();

        const history = configStore.getConfigHistorySnapshot();
        expect(history.entries).toHaveLength(2);
        expect(history.entries.at(-1)?.config.to).toBe('ja');
    });

    it('仅翻译计数、旧策略字段或迁移标记变化时不新增最近修改快照', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);

        await configStore.incrementConfigCount(12, 'history-excluded-count-operation');
        await configStore.saveConfig({
            ...configStore.config,
            count: 1,
            persistCredentials: true,
            videoServiceDefaultMigrated: false,
        }, {recordHistory: true, immediateHistory: true});

        const history = configStore.getConfigHistorySnapshot();
        expect(history.entries).toHaveLength(1);
        expect(history.entries[0]?.config).not.toHaveProperty('count');
        expect(history.entries[0]?.config).not.toHaveProperty('persistCredentials');
        expect(history.entries[0]?.config).not.toHaveProperty('videoServiceDefaultMigrated');
        expect(configStore.config).toMatchObject({
            count: 12,
            videoServiceDefaultMigrated: true,
        });
        expect(configStore.config).not.toHaveProperty('persistCredentials');
    });

    it('两个立即历史写入重叠时串行提交，不能丢失较新的快照或复用版本号', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        let releaseFirstHistoryWrite!: () => void;
        const firstHistoryWriteBlocked = new Promise<void>((resolve) => {
            releaseFirstHistoryWrite = resolve;
        });
        let historyWriteCount = 0;
        storageMock.setItem.mockImplementation(async (key: string, nextValue: unknown) => {
            storageOperations.push(`set:${key}`);
            if (key === 'local:configHistory' && historyWriteCount++ === 0) {
                await firstHistoryWriteBlocked;
            }
            storageState.set(key, structuredClone(nextValue));
        });

        const first = configStore.saveConfig(
            {...configStore.config, to: 'en'},
            {recordHistory: true, immediateHistory: true},
        );
        await vi.waitFor(() => expect(historyWriteCount).toBe(1));
        const second = configStore.saveConfig(
            {...configStore.config, to: 'ja'},
            {recordHistory: true, immediateHistory: true},
        );
        releaseFirstHistoryWrite();
        await Promise.all([first, second]);

        const history = configStore.getConfigHistorySnapshot();
        expect(history.entries.map((entry) => entry.config.to)).toEqual(['zh-Hans', 'en', 'ja']);
        expect(new Set(history.entries.map((entry) => entry.version)).size).toBe(history.entries.length);
        expect(storageState.get('local:configHistory')).toEqual(history);
    });

    it('配置历史 storage 外部更新会通知订阅者并保留版本结构', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        const listener = vi.fn();
        const unsubscribe = configStore.subscribeConfigHistory(listener);
        listener.mockClear();

        const current = configStore.getConfigHistorySnapshot();
        const external = {
            ...current,
            entries: [
                ...current.entries,
                {
                    version: current.nextVersion,
                    savedAt: new Date().toISOString(),
                    config: {...storedConfig, to: 'en'},
                },
            ],
            cursor: current.entries.length,
            nextVersion: current.nextVersion + 1,
        };
        const historyWatchCallback = storageMock.watch.mock.calls.find(([key]) => key === 'local:configHistory')![1];
        historyWatchCallback(external);

        expect(listener).toHaveBeenCalledWith(expect.objectContaining({
            entries: expect.arrayContaining([expect.objectContaining({config: expect.objectContaining({to: 'en'})})]),
        }));
        expect(configStore.getConfigHistorySnapshot().entries.at(-1)?.config.to).toBe('en');
        unsubscribe();
    });

    it('配置历史后台操作失败时回退到本地，并实际保存目标配置', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        await configStore.saveConfig({ ...configStore.config, to: 'en' }, {recordHistory: true, immediateHistory: true});
        await configStore.saveConfig({ ...configStore.config, to: 'ja' }, {recordHistory: true, immediateHistory: true});
        storageMock.setItem.mockClear();

        const sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
        await configStore.requestConfigHistoryAction('undo', undefined, sendMessage);

        expect(configStore.config.to).toBe('en');
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:config',
            expect.objectContaining({to: 'en'}),
        );
        expect(storageMock.setItem).toHaveBeenCalledWith(
            'local:configHistory',
            expect.objectContaining({cursor: 1}),
        );
    });

    it('后台明确返回历史操作失败时不绕过后台队列再次本地恢复', async () => {
        const configStore = await loadConfigModule(storedConfig);
        await Promise.all([configStore.configReady, configStore.configHistoryReady]);
        await configStore.saveConfig({...configStore.config, to: 'en'}, {recordHistory: true, immediateHistory: true});
        storageMock.setItem.mockClear();

        await expect(configStore.requestConfigHistoryAction(
            'undo',
            undefined,
            vi.fn().mockResolvedValue({success: false, error: 'background restore failed'}),
        )).rejects.toThrow('background restore failed');
        await expect(configStore.requestConfigHistoryAction(
            'undo',
            undefined,
            vi.fn().mockResolvedValue({success: true}),
        )).rejects.toThrow('没有返回结果');
        expect(storageMock.setItem).not.toHaveBeenCalled();
    });
});

describe('启动配置按需读取', () => {
    it('popup 首屏只读取主配置和持久凭据，历史消费者并发订阅只初始化一次', async () => {
        const store = await loadConfigModule(storedConfig, {writeOwner: false});
        await store.configReady;
        expect(storageOperations).toEqual(['get:local:config', 'get:local:credentials']);
        expect(storageWatchers.has('local:configHistory')).toBe(false);
        const listener = vi.fn();
        const unsubscribe = store.subscribeConfigHistory(listener);
        await Promise.all([store.configHistoryReady, store.configHistoryReady]);
        expect(storageOperations.filter(value => value === 'get:local:configHistory')).toHaveLength(1);
        expect(storageWatchers.has('local:configHistory')).toBe(true);
        unsubscribe();
    });

    it('普通网页启动和显式等待历史都不请求无权限记录或订阅历史', async () => {
        const store = await loadConfigModule(storedConfig, {trusted: false, writeOwner: false});
        await store.configReady;
        await store.configHistoryReady;
        expect(storageOperations).toEqual(['get:local:config']);
        expect(storageWatchers.has('local:configHistory')).toBe(false);
    });

    it.each(['旧快照', '读取失败'])('首次历史读取期间收到外部更新后，%s 不得回滚可撤销版本', async readOutcome => {
        const store = await loadConfigModule(storedConfig);
        await store.configReady;
        const baseline = store.getConfigHistorySnapshot();
        let releaseHistoryRead!: () => void;
        const historyReadBarrier = new Promise<void>(resolve => { releaseHistoryRead = resolve; });
        const defaultRead = storageMock.getItem.getMockImplementation()!;
        storageMock.getItem.mockImplementation(async (key: string) => {
            if (key !== 'local:configHistory') return defaultRead(key);
            await historyReadBarrier;
            if (readOutcome === '读取失败') throw new Error('stale history read failed');
            return baseline;
        });
        const historyReady = Promise.resolve(store.configHistoryReady);
        await vi.waitFor(() => expect(storageWatchers.has('local:configHistory')).toBe(true));
        const external = {
            ...baseline,
            entries: [
                ...baseline.entries,
                {version: baseline.nextVersion, savedAt: new Date().toISOString(), config: {...storedConfig, to: 'ja'}},
            ],
            cursor: baseline.entries.length,
            nextVersion: baseline.nextVersion + 1,
        };
        storageState.set('local:configHistory', external);
        storageWatchers.get('local:configHistory')!(external);
        releaseHistoryRead();
        await historyReady;

        expect(store.getConfigHistorySnapshot()).toMatchObject({
            cursor: external.cursor,
            nextVersion: external.nextVersion,
            entries: expect.arrayContaining([expect.objectContaining({config: expect.objectContaining({to: 'ja'})})]),
        });
    });
});

it('历史尚未打开时首次保存仍保留可撤销的原配置基线', async () => {
    const store = await loadConfigModule(storedConfig);
    await store.configReady;
    await store.saveConfig({...store.config, to: 'ja'}, {recordHistory: true, immediateHistory: true});
    expect(store.getConfigHistorySnapshot().entries.map(entry => entry.config.to)).toEqual(['zh-Hans', 'ja']);
    await store.applyConfigHistoryAction('undo');
    expect(store.config.to).toBe('zh-Hans');
});

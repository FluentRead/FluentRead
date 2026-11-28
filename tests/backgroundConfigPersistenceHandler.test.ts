import {describe, expect, it, vi} from 'vitest';

import {
    CONFIG_PERSIST_BATCH_MESSAGE_TYPE,
    CONFIG_PERSIST_CLIENT_SEQUENCE_LIMIT,
    CONFIG_PERSIST_MESSAGE_TYPE,
    createConfigMutationCoordinator,
    createConfigPersistenceBatchHandler,
    createConfigPersistenceHandler,
    type ConfigPersistenceBatchMessage,
    type ConfigPersistenceDependencies,
} from '@/src/app/background/handlers/configPersistence';
import {createBackgroundMessageRouter} from '@/src/services/messaging/backgroundRouter';

interface TestConfig {
    marker: string;
    allowCredentialUpdates?: boolean;
    videoTranslationEnabled?: boolean;
    theme?: string;
}

function createDependencies(overrides: Partial<ConfigPersistenceDependencies<TestConfig>> = {}) {
    const current = {marker: 'current'};
    const dependencies: ConfigPersistenceDependencies<TestConfig> = {
        ready: Promise.resolve(),
        getCurrentConfig: vi.fn(() => current),
        prepareConfigSaveRequest: vi.fn((incomingConfig, _currentConfig, allowCredentialUpdates) => ({
            marker: String(incomingConfig.marker),
            allowCredentialUpdates,
        })),
        prepareConfigPatchRequest: vi.fn((incomingPatch, _expectedPatch, currentConfig, allowCredentialUpdates) => ({
            ...currentConfig,
            ...incomingPatch,
            allowCredentialUpdates,
        })) as ConfigPersistenceDependencies<TestConfig>['prepareConfigPatchRequest'],
        saveConfig: vi.fn(async () => undefined),
        isExtensionUrl: vi.fn((url) => url.startsWith('chrome-extension://extension-id/')),
        getCurrentRevision: vi.fn(() => 4),
        ...overrides,
    };
    return dependencies;
}

describe('background config persistence handler', () => {
    it('只保留最近客户端的序号基线，且不淘汰仍有在途保存的客户端', async () => {
        let releasePinned!: () => void;
        const pinnedGate = new Promise<void>(resolve => { releasePinned = resolve; });
        const dependencies = createDependencies({
            saveConfig: vi.fn(async (config: TestConfig) => { if (config.marker === 'pinned') await pinnedGate; }),
        });
        const router = createBackgroundMessageRouter([createConfigPersistenceHandler(dependencies)]);
        const sender = {sender: {url: 'chrome-extension://extension-id/options.html'}};
        const save = (clientId: string, marker = clientId) => router.dispatch({
            type: CONFIG_PERSIST_MESSAGE_TYPE, config: {marker}, clientId, sequence: 1,
        }, sender);
        const pinned = save('pinned');
        await Promise.resolve();
        const clients = Array.from({length: CONFIG_PERSIST_CLIENT_SEQUENCE_LIMIT + 4}, (_, index) => `client-${index}`);
        const others = clients.map(clientId => save(clientId));
        releasePinned();
        await Promise.all([pinned, ...others]);
        expect(dependencies.saveConfig).toHaveBeenCalledWith(expect.objectContaining({marker: 'pinned'}), {recordHistory: true});
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(clients.length + 1);

        await save(clients.at(-1)!);
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(clients.length + 1);
        await save('client-0');
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(clients.length + 2);
    });

    it('按扩展 sender 权限保存配置，并记录历史', async () => {
        const dependencies = createDependencies();
        const router = createBackgroundMessageRouter([
            createConfigPersistenceHandler(dependencies),
        ]);

        await expect(router.dispatch({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'extension-save'},
            clientId: 'options-page',
            sequence: 1,
            baseRevision: 4,
        }, {sender: {url: 'chrome-extension://extension-id/options.html'}})).resolves.toEqual({
            handled: true,
            response: {success: true, revision: 4},
        });

        expect(dependencies.prepareConfigSaveRequest).toHaveBeenCalledWith(
            {marker: 'extension-save'},
            {marker: 'current'},
            true,
        );
        expect(dependencies.saveConfig).toHaveBeenCalledWith(
            {marker: 'extension-save', allowCredentialUpdates: true},
            {recordHistory: true},
        );
        expect(dependencies.prepareConfigPatchRequest).not.toHaveBeenCalled();
    });

    it('patch 忽略旧 baseRevision，并在临界区基于最新配置只合并目标字段', async () => {
        const latestConfig: TestConfig = {
            marker: 'latest-external-value',
            videoTranslationEnabled: true,
            theme: 'dark',
        };
        const prepareConfigPatchRequest = vi.fn((
            incomingPatch: Record<string, unknown>,
            _expectedPatch: Record<string, unknown>,
            current: TestConfig,
        ) => ({
            ...current,
            marker: String(incomingPatch.marker),
        }));
        const dependencies = createDependencies({
            getCurrentConfig: () => latestConfig,
            getCurrentRevision: () => 9,
            prepareConfigPatchRequest,
        });
        const handler = createConfigPersistenceHandler(dependencies);

        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            mode: 'patch',
            config: {marker: 'patched-field'},
            expected: {marker: 'latest-external-value'},
            clientId: 'content-video',
            sequence: 1,
            baseRevision: 4,
        }, {sender: {url: 'https://www.youtube.com/watch?v=test'}}))
            .resolves.toEqual({success: true, revision: 9});

        expect(prepareConfigPatchRequest).toHaveBeenCalledWith(
            {marker: 'patched-field'},
            {marker: 'latest-external-value'},
            latestConfig,
            false,
        );
        expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
        expect(dependencies.saveConfig).toHaveBeenCalledWith({
            marker: 'patched-field',
            videoTranslationEnabled: true,
            theme: 'dark',
        }, {recordHistory: true});
    });

    it('patch 的目标字段在 base 后变化时拒绝迟到写入', async () => {
        const latestConfig: TestConfig = {
            marker: 'external-new-value',
            videoTranslationEnabled: true,
        };
        const prepareConfigPatchRequest = vi.fn((
            incomingPatch: Record<string, unknown>,
            expectedPatch: Record<string, unknown>,
            current: TestConfig,
        ) => {
            if (current.marker !== expectedPatch.marker) {
                throw new Error('配置字段已更新，请同步后重试：marker');
            }
            return {...current, marker: String(incomingPatch.marker)};
        });
        const dependencies = createDependencies({
            getCurrentConfig: () => latestConfig,
            getCurrentRevision: () => 9,
            prepareConfigPatchRequest,
        });
        const handler = createConfigPersistenceHandler(dependencies);

        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            mode: 'patch',
            config: {marker: 'late-local-value'},
            expected: {marker: 'old-base-value'},
            clientId: 'late-content',
            sequence: 1,
            baseRevision: 4,
        }, {})).rejects.toThrow('marker');

        expect(dependencies.saveConfig).not.toHaveBeenCalled();
        expect(latestConfig).toEqual({marker: 'external-new-value', videoTranslationEnabled: true});
    });

    it('content sender 使用 legacy clientId fallback，且不能更新凭据', async () => {
        const dependencies = createDependencies();
        const handler = createConfigPersistenceHandler(dependencies);

        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'content-save'},
        }, {
            sender: {
                id: 'content-script',
                url: 'https://example.com/article',
                frameId: 3,
                tab: {id: 7},
            },
        })).resolves.toEqual({success: true, revision: 4});

        expect(dependencies.prepareConfigSaveRequest).toHaveBeenCalledWith(
            {marker: 'content-save'},
            {marker: 'current'},
            false,
        );
    });

    it('同一 client 并发保存只让最新 sequence 落盘', async () => {
        const dependencies = createDependencies();
        const handler = createConfigPersistenceHandler(dependencies);

        const first = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'old'},
            clientId: 'popup',
            sequence: 1,
        }, {});
        const second = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'new'},
            clientId: 'popup',
            sequence: 2,
        }, {});

        await expect(Promise.all([first, second])).resolves.toEqual([
            {success: true, revision: 4},
            {success: true, revision: 4},
        ]);
        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
        expect(dependencies.saveConfig).toHaveBeenCalledWith(
            {marker: 'new', allowCredentialUpdates: false},
            {recordHistory: true},
        );
    });

    it.each([
        ['patch', true], ['patch', false], ['replace', true], ['replace', false],
    ] as const)('等待 ready 时被新序号取代的 %s 请求不触发 CAS、写入或历史（revision port=%s）', async (mode, hasRevisionPort) => {
        let releaseReady!: () => void;
        const ready = new Promise<void>(resolve => {releaseReady = resolve;});
        let enteredMutation!: () => void;
        const entered = new Promise<void>(resolve => {enteredMutation = resolve;});
        const coordinator = createConfigMutationCoordinator();
        let current: TestConfig = {marker: 'hydrated-current'};
        let revision = 9;
        const history: string[] = [];
        const dependencies = createDependencies({
            ready,
            runMutation: mutation => coordinator.run(async () => {
                enteredMutation();
                return mutation();
            }),
            getCurrentConfig: vi.fn(() => current),
            getCurrentRevision: hasRevisionPort ? () => revision : undefined,
            prepareConfigPatchRequest: vi.fn((patch, expected, source) => {
                if (source.marker !== expected.marker) throw new Error('stale patch must not reach CAS');
                return {...source, marker: String(patch.marker)};
            }),
            saveConfig: vi.fn(async (next, options) => {
                current = next;
                revision += 1;
                if (options.recordHistory) history.push(next.marker);
            }),
        });
        const handler = createConfigPersistenceHandler(dependencies);
        const first = handler.handle({type: CONFIG_PERSIST_MESSAGE_TYPE, mode,
            config: {marker: 'old'}, expected: {marker: 'stale-before-hydration'},
            clientId: 'hydrating-options', sequence: 1, baseRevision: 4}, {});
        // 等待公开 mutation 端口进入真实 handler；旧请求已经通过首次序号检查并挂在 ready 上。
        await entered;
        expect(dependencies.getCurrentConfig).not.toHaveBeenCalled();
        expect(dependencies.prepareConfigPatchRequest).not.toHaveBeenCalled();
        expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
        expect(dependencies.saveConfig).not.toHaveBeenCalled();
        const latest = handler.handle({type: CONFIG_PERSIST_MESSAGE_TYPE, mode,
            config: {marker: 'latest'}, expected: {marker: 'hydrated-current'},
            clientId: 'hydrating-options', sequence: 2, baseRevision: 9}, {});
        releaseReady();

        await expect(first).resolves.toEqual({success: true, revision: hasRevisionPort ? 9 : 0});
        await expect(latest).resolves.toEqual({success: true, revision: hasRevisionPort ? 10 : 0});
        expect(current.marker).toBe('latest');
        expect(history).toEqual(['latest']);
        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
        expect(dependencies.saveConfig).toHaveBeenCalledWith(expect.objectContaining({marker: 'latest'}), {recordHistory: true});
        expect(dependencies.getCurrentConfig).toHaveBeenCalledOnce();
        if (mode === 'patch') {
            expect(dependencies.prepareConfigPatchRequest).toHaveBeenCalledOnce();
            expect(dependencies.prepareConfigPatchRequest).toHaveBeenCalledWith(
                {marker: 'latest'}, {marker: 'hydrated-current'}, {marker: 'hydrated-current'}, false,
            );
            expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
        } else {
            expect(dependencies.prepareConfigSaveRequest).toHaveBeenCalledOnce();
            expect(dependencies.prepareConfigSaveRequest).toHaveBeenCalledWith({marker: 'latest'}, {marker: 'hydrated-current'}, false);
            expect(dependencies.prepareConfigPatchRequest).not.toHaveBeenCalled();
        }
    });

    it('未注入 revision 读取器时所有 sequence 分支稳定回退为 revision 0', async () => {
        const dependencies = createDependencies({getCurrentRevision: undefined});
        const handler = createConfigPersistenceHandler(dependencies);
        const first = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'superseded'},
            clientId: 'legacy-client',
            sequence: 1,
        }, {});
        const latest = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'latest'},
            clientId: 'legacy-client',
            sequence: 2,
        }, {});
        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'stale-while-latest-pending'},
            clientId: 'legacy-client',
            sequence: 1,
        }, {})).resolves.toEqual({success: true, revision: 0});

        await expect(Promise.all([first, latest])).resolves.toEqual([
            {success: true, revision: 0},
            {success: true, revision: 0},
        ]);
        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'stale'},
            clientId: 'legacy-client',
            sequence: 1,
        }, {})).resolves.toEqual({success: true, revision: 0});
        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
    });

    it('tabId 为 0 时仍保留独立 fallback client 身份', async () => {
        const dependencies = createDependencies();
        const handler = createConfigPersistenceHandler(dependencies);

        const first = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'tab-zero'},
            sequence: 1,
        }, {sender: {tab: {id: 0}, frameId: 0}});
        const second = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'extension-page'},
            sequence: 2,
        }, {sender: {frameId: 0}});

        await expect(Promise.all([first, second])).resolves.toEqual([
            {success: true, revision: 4},
            {success: true, revision: 4},
        ]);
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(2);
        expect(dependencies.saveConfig).toHaveBeenNthCalledWith(
            1,
            {marker: 'tab-zero', allowCredentialUpdates: false},
            {recordHistory: true},
        );
        expect(dependencies.saveConfig).toHaveBeenNthCalledWith(
            2,
            {marker: 'extension-page', allowCredentialUpdates: false},
            {recordHistory: true},
        );
    });

    it('过期 sequence 直接成功返回，不重复覆盖最新配置', async () => {
        const dependencies = createDependencies();
        const handler = createConfigPersistenceHandler(dependencies);

        await handler.handle({type: CONFIG_PERSIST_MESSAGE_TYPE, config: {marker: 'new'}, clientId: 'options', sequence: 8}, {});
        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'old'},
            clientId: 'options',
            sequence: 7,
        }, {})).resolves.toEqual({success: true, revision: 4});

        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
        expect(dependencies.saveConfig).toHaveBeenCalledWith(
            {marker: 'new', allowCredentialUpdates: false},
            {recordHistory: true},
        );
    });

    it('无 sequence 保存保持队列顺序，前一个失败后后续请求仍可继续', async () => {
        let releaseFirst!: () => void;
        const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const saveOrder: string[] = [];
        const dependencies = createDependencies({
            saveConfig: vi.fn(async (config) => {
                saveOrder.push(config.marker);
                if (config.marker === 'first') {
                    await firstStarted;
                    throw new Error('first failed');
                }
            }),
        });
        const handler = createConfigPersistenceHandler(dependencies);

        const first = handler.handle({type: CONFIG_PERSIST_MESSAGE_TYPE, config: {marker: 'first'}}, {});
        const second = handler.handle({type: CONFIG_PERSIST_MESSAGE_TYPE, config: {marker: 'second'}}, {});
        await vi.waitFor(() => expect(saveOrder).toEqual(['first']));
        releaseFirst();

        await expect(first).rejects.toThrow('first failed');
        await expect(second).resolves.toEqual({success: true, revision: 4});
        expect(saveOrder).toEqual(['first', 'second']);
    });

    it('带 sequence 的保存失败后允许同序号重试真正落盘', async () => {
        const saveConfig = vi.fn()
            .mockRejectedValueOnce(new Error('storage temporarily unavailable'))
            .mockResolvedValueOnce(undefined);
        const handler = createConfigPersistenceHandler(createDependencies({saveConfig}));
        const message = {
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'retryable'},
            clientId: 'options-retry',
            sequence: 1,
        } as const;

        await expect(handler.handle(message, {})).rejects.toThrow('storage temporarily unavailable');
        await expect(handler.handle(message, {})).resolves.toEqual({success: true, revision: 4});
        expect(saveConfig).toHaveBeenCalledTimes(2);
    });

    it('同序号在途重试共享原请求结果，不在落盘前误报成功', async () => {
        let releaseSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const saveConfig = vi.fn(async () => {
            await saveGate;
            throw new Error('shared failure');
        });
        const handler = createConfigPersistenceHandler(createDependencies({saveConfig}));
        const message = {
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'deduplicated'},
            clientId: 'popup-retry',
            sequence: 1,
        } as const;

        const first = handler.handle(message, {});
        await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
        const duplicate = handler.handle(message, {});
        releaseSave();

        await expect(first).rejects.toThrow('shared failure');
        await expect(duplicate).rejects.toThrow('shared failure');
        expect(saveConfig).toHaveBeenCalledOnce();
    });

    it('未提交的最新序号屏蔽更旧请求，同序号重复共享成功 revision', async () => {
        let releaseSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const saveConfig = vi.fn(async () => saveGate);
        const handler = createConfigPersistenceHandler(createDependencies({saveConfig}));
        const latestMessage = {
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'latest-pending'},
            clientId: 'pending-client',
            sequence: 2,
        } as const;

        const latest = handler.handle(latestMessage, {});
        await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
        await expect(handler.handle({
            ...latestMessage,
            config: {marker: 'stale-pending'},
            sequence: 1,
        }, {})).resolves.toEqual({success: true, revision: 4});
        const duplicate = handler.handle(latestMessage, {});
        releaseSave();

        await expect(latest).resolves.toEqual({success: true, revision: 4});
        await expect(duplicate).resolves.toEqual({success: true, revision: 4});
        expect(saveConfig).toHaveBeenCalledOnce();
    });

    it.each([
        [{type: CONFIG_PERSIST_MESSAGE_TYPE}, 'config'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: []}, 'config'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: {}, clientId: ''}, 'clientId'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: {}, clientId: 42}, 'clientId'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: {}, sequence: -1}, 'sequence'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: {}, sequence: 1.5}, 'sequence'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: {}, baseRevision: -1}, 'baseRevision'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, config: {}, baseRevision: 1.5}, 'baseRevision'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, mode: 'merge', config: {}}, 'mode'],
        [{type: CONFIG_PERSIST_MESSAGE_TYPE, mode: 'patch', config: {}}, 'expected'],
    ])('拒绝非法配置保存消息 %#', async (message, field) => {
        const handler = createConfigPersistenceHandler(createDependencies());

        await expect(handler.handle(message, {})).rejects.toThrow(field);
    });

    it('拒绝基于旧 revision 的整份快照，避免覆盖刚恢复或导入的配置', async () => {
        const dependencies = createDependencies({getCurrentRevision: vi.fn(() => 5)});
        const handler = createConfigPersistenceHandler(dependencies);

        await expect(handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'stale-content-snapshot'},
            clientId: 'content',
            sequence: 1,
            baseRevision: 4,
        }, {})).rejects.toThrow('当前 revision 5');
        expect(dependencies.saveConfig).not.toHaveBeenCalled();
    });

    it('外部恢复与普通保存共用 mutation coordinator 串行执行', async () => {
        const coordinator = createConfigMutationCoordinator();
        let revision = 4;
        let releaseRestore!: () => void;
        const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
        const order: string[] = [];
        const dependencies = createDependencies({
            getCurrentRevision: () => revision,
            runMutation: coordinator.run,
            saveConfig: vi.fn(async () => { order.push('save'); revision += 1; }),
        });
        const handler = createConfigPersistenceHandler(dependencies);
        const restore = coordinator.run(async () => {
            order.push('restore-start');
            await restoreGate;
            revision += 1;
            order.push('restore-end');
        });
        const staleSave = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'stale-after-restore'},
            baseRevision: 4,
        }, {});

        await vi.waitFor(() => expect(order).toEqual(['restore-start']));
        releaseRestore();
        await restore;
        await expect(staleSave).rejects.toThrow('当前 revision 5');
        expect(order).toEqual(['restore-start', 'restore-end']);
    });

    it('在 mutation 临界区内捕获本次提交 revision，不误报紧随其后的恢复版本', async () => {
        const coordinator = createConfigMutationCoordinator();
        let revision = 4;
        let releaseSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const saveStarted = vi.fn();
        const dependencies = createDependencies({
            getCurrentRevision: () => revision,
            runMutation: coordinator.run,
            saveConfig: vi.fn(async () => {
                saveStarted();
                await saveGate;
                revision = 5;
            }),
        });
        const handler = createConfigPersistenceHandler(dependencies);
        const request = handler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            config: {marker: 'save-before-restore'},
            baseRevision: 4,
        }, {});
        await vi.waitFor(() => expect(saveStarted).toHaveBeenCalledOnce());
        const followingRestore = coordinator.run(async () => { revision = 6; });

        releaseSave();
        await expect(request).resolves.toEqual({success: true, revision: 5});
        await followingRestore;
        expect(revision).toBe(6);
    });
});

describe('background config persistence batch handler', () => {
    const context = {sender: {url: 'chrome-extension://extension-id/popup.html'}};
    const firstPatch = {sequence: 1, config: {marker: 'first'}, expected: {marker: 'current'}};
    const secondPatch = {sequence: 2, config: {marker: 'second'}, expected: {marker: 'first'}};
    const batchMessage = {
        type: CONFIG_PERSIST_BATCH_MESSAGE_TYPE,
        clientId: 'popup-batch',
        patches: [firstPatch, secondPatch],
    };

    function createStatefulFixture(beforeSave?: () => Promise<void>) {
        let current: TestConfig = {marker: 'current', videoTranslationEnabled: true, theme: 'dark'};
        let revision = 4;
        const dependencies = createDependencies({
            getCurrentConfig: () => current,
            getCurrentRevision: () => revision,
            runMutation: createConfigMutationCoordinator().run,
            prepareConfigPatchRequest: vi.fn((config, expected, currentConfig, allowCredentialUpdates) => {
                if (Object.entries(expected).some(([key, value]) => Reflect.get(currentConfig, key) !== value)) {
                    throw new Error('配置字段已更新，请同步后重试');
                }
                return {...currentConfig, ...config, allowCredentialUpdates};
            }),
            saveConfig: vi.fn(async (config) => {
                await beforeSave?.();
                current = config;
                revision += 1;
            }),
        });
        const singleHandler = createConfigPersistenceHandler(dependencies);
        const singleHandle = vi.spyOn(singleHandler, 'handle');
        const batchHandler = createConfigPersistenceBatchHandler(singleHandler);
        return {dependencies, singleHandler, singleHandle, batchHandler};
    }

    it('共享单条处理器在途前驱的结果，再应用依赖该前驱的后继补丁', async () => {
        let releaseSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const {dependencies, singleHandler, singleHandle, batchHandler} = createStatefulFixture(() => saveGate);
        const first = singleHandler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            mode: 'patch',
            clientId: batchMessage.clientId,
            ...firstPatch,
        }, context);
        await vi.waitFor(() => expect(dependencies.saveConfig).toHaveBeenCalledOnce());

        const batch = batchHandler.handle(batchMessage, context);
        await vi.waitFor(() => expect(singleHandle).toHaveBeenCalledTimes(2));
        expect(dependencies.prepareConfigPatchRequest).toHaveBeenCalledOnce();
        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
        releaseSave();

        await expect(first).resolves.toEqual({success: true, revision: 5});
        await expect(batch).resolves.toEqual({success: true, revision: 6});
        expect(singleHandle).toHaveBeenCalledTimes(3);
        expect(singleHandle.mock.calls.every(([, senderContext]) => senderContext === context)).toBe(true);
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(2);
        expect(dependencies.getCurrentConfig()).toEqual({
            marker: 'second',
            videoTranslationEnabled: true,
            theme: 'dark',
            allowCredentialUpdates: true,
        });
        expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
    });

    it('已经提交的前驱去重，后继仍通过同一处理器保存并返回最终 revision', async () => {
        const {dependencies, singleHandler, singleHandle, batchHandler} = createStatefulFixture();
        await singleHandler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            mode: 'patch',
            clientId: batchMessage.clientId,
            ...firstPatch,
        }, context);
        const router = createBackgroundMessageRouter([singleHandler, batchHandler]);

        await expect(router.dispatch(batchMessage, context)).resolves.toEqual({
            handled: true,
            response: {success: true, revision: 6},
        });
        expect(singleHandle).toHaveBeenCalledTimes(3);
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(2);
        expect(dependencies.prepareConfigPatchRequest).toHaveBeenCalledTimes(2);
        expect(dependencies.getCurrentConfig().marker).toBe('second');
    });

    it('批次中途 CAS 失败后停止后续补丁，保留已提交前驱且不回退为整份替换', async () => {
        const {dependencies, singleHandle, batchHandler} = createStatefulFixture();

        await expect(batchHandler.handle({
            ...batchMessage,
            patches: [
                firstPatch,
                {...secondPatch, expected: {marker: 'stale-value'}},
                {sequence: 3, config: {marker: 'must-not-save'}, expected: {marker: 'second'}},
            ],
        }, context)).rejects.toThrow('配置字段已更新');

        expect(singleHandle).toHaveBeenCalledTimes(2);
        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
        expect(dependencies.getCurrentConfig().marker).toBe('first');
        expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
        await expect(batchHandler.handle(batchMessage, context)).resolves.toEqual({success: true, revision: 6});
        expect(dependencies.saveConfig).toHaveBeenCalledTimes(2);
        expect(dependencies.getCurrentConfig().marker).toBe('second');
    });

    it('前驱存储失败时共享失败并停止后续补丁', async () => {
        let releaseSave!: () => void;
        const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
        const {dependencies, singleHandler, singleHandle, batchHandler} = createStatefulFixture(async () => {
            await saveGate;
            throw new Error('storage unavailable');
        });
        const first = singleHandler.handle({
            type: CONFIG_PERSIST_MESSAGE_TYPE,
            mode: 'patch',
            clientId: batchMessage.clientId,
            ...firstPatch,
        }, context);
        await vi.waitFor(() => expect(dependencies.saveConfig).toHaveBeenCalledOnce());
        const batch = batchHandler.handle(batchMessage, context);
        const outcomes = Promise.allSettled([first, batch]);
        releaseSave();

        expect(await outcomes).toEqual([
            {status: 'rejected', reason: new Error('storage unavailable')},
            {status: 'rejected', reason: new Error('storage unavailable')},
        ]);
        expect(singleHandle).toHaveBeenCalledTimes(2);
        expect(dependencies.saveConfig).toHaveBeenCalledOnce();
        expect(dependencies.getCurrentConfig().marker).toBe('current');
    });

    it('content sender 原样传递且每个补丁都没有凭据更新权限', async () => {
        const {dependencies, singleHandle, batchHandler} = createStatefulFixture();
        const contentContext = {
            sender: {id: 'extension-id', url: 'https://example.com/article', tab: {id: 7}, frameId: 3},
        };

        await expect(batchHandler.handle(batchMessage, contentContext)).resolves.toEqual({success: true, revision: 6});

        expect(singleHandle.mock.calls.every(([, senderContext]) => senderContext === contentContext)).toBe(true);
        expect(dependencies.isExtensionUrl).toHaveBeenCalledTimes(2);
        expect(dependencies.isExtensionUrl).toHaveBeenCalledWith(contentContext.sender.url);
        expect(vi.mocked(dependencies.prepareConfigPatchRequest).mock.calls.map((call) => call[3])).toEqual([false, false]);
        expect(dependencies.getCurrentConfig().allowCredentialUpdates).toBe(false);
        expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
    });

    it('接受普通或 null 原型对象、不同字段顺序和最多 256 条严格递增补丁', async () => {
        const {dependencies, batchHandler} = createStatefulFixture();
        const patches = Array.from({length: 256}, (_, index) => Object.assign(Object.create(null), {
            sequence: index * 2 + 1,
            config: Object.assign(Object.create(null), {marker: `value-${index}`, theme: 'dark'}),
            expected: {theme: 'dark', marker: index === 0 ? 'current' : `value-${index - 1}`},
        }));

        await expect(batchHandler.handle(Object.assign(Object.create(null), {
            ...batchMessage,
            patches,
        }), context)).resolves.toEqual({success: true, revision: 260});

        expect(dependencies.saveConfig).toHaveBeenCalledTimes(256);
        expect(dependencies.getCurrentConfig().marker).toBe('value-255');
    });

    const invalidMessages: Array<[string, unknown]> = [
        ['null payload', null],
        ['array payload', []],
        ['unexpected type', {...batchMessage, type: CONFIG_PERSIST_MESSAGE_TYPE}],
        ['inherited payload', Object.assign(Object.create({extra: true}), batchMessage)],
        ['missing clientId', {type: CONFIG_PERSIST_BATCH_MESSAGE_TYPE, patches: [firstPatch]}],
        ['empty clientId', {...batchMessage, clientId: '  '}],
        ['non-string clientId', {...batchMessage, clientId: 42}],
        ['missing patches', {type: CONFIG_PERSIST_BATCH_MESSAGE_TYPE, clientId: 'popup'}],
        ['non-array patches', {...batchMessage, patches: {0: firstPatch}}],
        ['empty patches', {...batchMessage, patches: []}],
        ['oversized patches', {...batchMessage, patches: Array.from({length: 257}, (_, index) => ({...firstPatch, sequence: index + 1}))}],
        ['extra top-level mode', {...batchMessage, mode: 'replace'}],
        ['extra top-level config', {...batchMessage, config: {marker: 'replace'}}],
        ['extra top-level baseRevision', {...batchMessage, baseRevision: 4}],
        ['extra top-level symbol', {...batchMessage, [Symbol('extra')]: true}],
        ['extra hidden top-level field', Object.defineProperty({...batchMessage}, 'extra', {value: true})],
    ];
    const invalidPatches: Array<[string, unknown]> = [
        ['null patch', null],
        ['array patch', []],
        ['inherited patch', Object.assign(Object.create({extra: true}), secondPatch)],
        ['missing sequence', {config: {marker: 'second'}, expected: {marker: 'first'}}],
        ['zero sequence', {...secondPatch, sequence: 0}],
        ['negative sequence', {...secondPatch, sequence: -1}],
        ['fractional sequence', {...secondPatch, sequence: 1.5}],
        ['unsafe sequence', {...secondPatch, sequence: Number.MAX_SAFE_INTEGER + 1}],
        ['infinite sequence', {...secondPatch, sequence: Infinity}],
        ['NaN sequence', {...secondPatch, sequence: NaN}],
        ['non-numeric sequence', {...secondPatch, sequence: '2'}],
        ['duplicate sequence', {...secondPatch, sequence: 1}],
        ['missing config', {sequence: 2, expected: {marker: 'first'}}],
        ['null config', {...secondPatch, config: null}],
        ['array config', {...secondPatch, config: []}],
        ['class config', {...secondPatch, config: new Date()}],
        ['inherited config', {...secondPatch, config: Object.assign(Object.create({extra: true}), secondPatch.config)}],
        ['empty config', {...secondPatch, config: {}, expected: {}}],
        ['symbol config field', {...secondPatch, config: {...secondPatch.config, [Symbol('extra')]: true}}],
        ['missing expected', {sequence: 2, config: {marker: 'second'}}],
        ['null expected', {...secondPatch, expected: null}],
        ['array expected', {...secondPatch, expected: []}],
        ['class expected', {...secondPatch, expected: new Map()}],
        ['inherited expected', {...secondPatch, expected: Object.assign(Object.create({extra: true}), secondPatch.expected)}],
        ['empty expected', {...secondPatch, expected: {}}],
        ['different expected fields', {...secondPatch, expected: {theme: 'dark'}}],
        ['extra expected field', {...secondPatch, expected: {marker: 'first', theme: 'dark'}}],
        ['extra patch mode', {...secondPatch, mode: 'replace'}],
        ['extra patch type', {...secondPatch, type: CONFIG_PERSIST_MESSAGE_TYPE}],
        ['extra patch clientId', {...secondPatch, clientId: 'other-client'}],
        ['extra patch baseRevision', {...secondPatch, baseRevision: 4}],
        ['extra patch symbol', {...secondPatch, [Symbol('extra')]: true}],
    ];

    it.each([
        ...invalidMessages,
        ...invalidPatches.map(([name, patch]): [string, unknown] => [name, {...batchMessage, patches: [firstPatch, patch]}]),
        ['descending sequence', {...batchMessage, patches: [{...firstPatch, sequence: 3}, secondPatch]}],
        ['sparse patches', {...batchMessage, patches: [firstPatch, , secondPatch]}],
    ])('完整预校验拒绝 %s，任何单条 handler 和写入都未开始', async (_name, message) => {
        const {dependencies, singleHandle, batchHandler} = createStatefulFixture();

        await expect(batchHandler.handle(message as ConfigPersistenceBatchMessage, context)).rejects.toThrow(TypeError);

        expect(singleHandle).not.toHaveBeenCalled();
        expect(dependencies.prepareConfigPatchRequest).not.toHaveBeenCalled();
        expect(dependencies.prepareConfigSaveRequest).not.toHaveBeenCalled();
        expect(dependencies.saveConfig).not.toHaveBeenCalled();
        expect(dependencies.getCurrentConfig().marker).toBe('current');
    });
});

import {describe, expect, it} from 'vitest';
import {buildConfigHistoryTimeline} from '@/src/features/settings/model/configHistory';
import {services} from '@/src/core/config/catalog';

import {
    CONFIG_HISTORY_LIMIT,
    appendConfigHistorySnapshot,
    cloneConfigHistory,
    createBaselineConfigHistory,
    parseConfigHistory,
    resolveConfigHistoryTargetIndex,
    restoreRestorableConfig,
    serializeConfigHistory,
    toPublicConfig,
    toRestorableConfig,
    type ConfigHistoryState,
} from '@/src/services/config/history';
import {
    CONFIG_REVISION_FIELD,
    getStoredConfigRevision,
    isConfigRecord,
    parseStoredConfig,
    serializeConfig,
} from '@/src/services/config/schema';

const baseConfig = {
    on: true,
    service: 'freeTranslation',
    from: 'auto',
    to: 'zh-Hans',
};

function entry(version: number, to = 'zh-Hans') {
    return {
        version,
        savedAt: `2026-08-25T00:00:0${version}.000Z`,
        config: toPublicConfig({...baseConfig, to}),
    };
}

function history(overrides: Partial<ConfigHistoryState> = {}): ConfigHistoryState {
    return {
        schemaVersion: 1,
        entries: [entry(1), entry(2, 'en')],
        cursor: 1,
        nextVersion: 3,
        ...overrides,
    };
}

describe('配置 schema 与历史纯状态机', () => {
    it('识别全部节点设置进入普通历史，撤销重做与旧快照恢复采用规范化范围', () => {
        const baseline = createBaselineConfigHistory({...baseConfig, translationScope: 'content'}, 1);
        const changed = appendConfigHistorySnapshot(baseline, {...baseConfig, translationScope: 'all'})!;
        expect(changed.entries).toHaveLength(2);
        expect(changed.entries[1].config.translationScope).toBe('all');
        const undoIndex = resolveConfigHistoryTargetIndex(changed, 'undo')!;
        expect(restoreRestorableConfig(changed.entries[undoIndex].config, baseConfig).translationScope).toBe('content');
        const redoIndex = resolveConfigHistoryTargetIndex({...changed, cursor: undoIndex}, 'redo')!;
        expect(restoreRestorableConfig(changed.entries[redoIndex].config, baseConfig).translationScope).toBe('all');
        expect(restoreRestorableConfig(baseConfig, {...baseConfig, translationScope: 'all'}).translationScope).toBe('content');
        expect(parseConfigHistory(JSON.parse(serializeConfigHistory(changed)))?.entries[1].config.translationScope).toBe('all');
    });

    it('DeepL 套餐经过配置历史序列化和恢复保持一致', () => {
        const current = {...baseConfig, deeplApiPlan: 'free', token: {deepL: 'free-key'}};
        const baseline = createBaselineConfigHistory(current, 1, 'free-time');
        const updated = appendConfigHistorySnapshot(baseline, {...current, deeplApiPlan: 'pro'}, 'pro-time')!;
        const parsed = parseConfigHistory(JSON.parse(serializeConfigHistory(updated)))!;

        expect(parsed.entries.map(item => item.config.deeplApiPlan)).toEqual(['free', 'pro']);
        const restored = restoreRestorableConfig(parsed.entries[1]!.config, current);
        expect(restored.deeplApiPlan).toBe('pro');
        expect(restored.token).not.toHaveProperty('deepL');
        expect(restoreRestorableConfig(parsed.entries[0]!.config, current).token.deepL).toBe('free-key');
    });

    it('存储 schema 只接受完整对象或合法旧 JSON，并规范化 revision', () => {
        expect(isConfigRecord({})).toBe(true);
        expect(isConfigRecord(null)).toBe(false);
        expect(isConfigRecord([])).toBe(false);
        expect(getStoredConfigRevision(null)).toBe(0);
        expect(getStoredConfigRevision({[CONFIG_REVISION_FIELD]: 7})).toBe(7);
        expect(getStoredConfigRevision({[CONFIG_REVISION_FIELD]: -1})).toBe(0);
        expect(getStoredConfigRevision({[CONFIG_REVISION_FIELD]: 1.5})).toBe(0);
        expect(parseStoredConfig('')).toBeNull();
        expect(parseStoredConfig('{bad-json')).toBeNull();
        expect(parseStoredConfig('[]')).toBeNull();
        expect(parseStoredConfig({on: true})).toBeNull();
        expect(parseStoredConfig(JSON.stringify(baseConfig))).toEqual(baseConfig);
        expect(parseStoredConfig(baseConfig)).toBe(baseConfig);
        expect(serializeConfig({on: true})).toBe('{"on":true}');
    });

    it('公开快照与克隆递归移除凭据、保留普通未知字段且不共享可变引用', () => {
        const publicConfig = toPublicConfig({
            ...baseConfig,
            token: {openai: 'secret'},
            futureProvider: {
                apiToken: 'nested-secret',
                region: 'global',
                nested: {password: 'hidden', mode: 'fast'},
            },
        });
        expect((publicConfig as Record<string, unknown>).token).toBeUndefined();
        expect((publicConfig as unknown as Record<string, unknown>).futureProvider).toEqual({
            region: 'global',
            nested: {mode: 'fast'},
        });

        const source = history({
            entries: [{
                ...entry(1),
                config: {
                    ...baseConfig,
                    token: {openai: 'secret'},
                    futureProvider: {
                        apiToken: 'nested-secret',
                        region: 'global',
                    },
                } as never,
            }],
            cursor: 0,
            nextVersion: 2,
        });
        const cloned = cloneConfigHistory(source);
        expect(cloned).not.toBe(source);
        expect(cloned.entries[0]).not.toBe(source.entries[0]);
        expect((cloned.entries[0]?.config as Record<string, unknown>).token).toBeUndefined();
        expect((cloned.entries[0]?.config as unknown as Record<string, unknown>).futureProvider).toEqual({
            region: 'global',
        });
        expect(serializeConfigHistory(cloned)).toBe(JSON.stringify(cloned));
    });

    it('历史快照与恢复往返保留内置服务的已保存模型列表', () => {
        const snapshot = toRestorableConfig({
            ...baseConfig,
            customModels: {grok: ['private-a', 'private-b']},
        });
        const restored = restoreRestorableConfig(snapshot, {
            ...baseConfig,
            customModels: {grok: ['current-only']},
        });

        expect(snapshot.customModels).toEqual({grok: ['private-a', 'private-b']});
        expect(restored.customModels).toEqual({grok: ['private-a', 'private-b']});
    });

    it('基线版本尊重持久化 revision，并支持显式或默认保存时间', () => {
        const fixed = createBaselineConfigHistory(baseConfig, 4, 'fixed-time');
        expect(fixed).toMatchObject({
            entries: [{version: 4, savedAt: 'fixed-time'}],
            cursor: 0,
            nextVersion: 5,
        });
        const fallback = createBaselineConfigHistory(baseConfig, 0);
        expect(fallback.entries[0]?.version).toBe(1);
        expect(fallback.entries[0]?.savedAt).toEqual(expect.any(String));
    });

    it('历史解析过滤损坏条目、限制十条，并修正游标与 nextVersion', () => {
        expect(parseConfigHistory(null)).toBeNull();
        expect(parseConfigHistory({entries: 'bad'})).toBeNull();
        expect(parseConfigHistory({schemaVersion: 2, entries: [entry(1)]})).toBeNull();
        expect(parseConfigHistory({entries: [null, {version: '1', savedAt: 'x', config: baseConfig}]})).toBeNull();
        expect(parseConfigHistory({entries: [{version: -1, savedAt: 'x', config: baseConfig}]})).toBeNull();
        expect(parseConfigHistory({entries: [{version: 1.5, savedAt: 'x', config: baseConfig}]})).toBeNull();
        expect(parseConfigHistory({entries: [{version: 1, savedAt: 123, config: baseConfig}]})).toBeNull();
        expect(parseConfigHistory({entries: [{version: 1, savedAt: 'x', config: {on: true}}]})).toBeNull();

        const parsed = parseConfigHistory({
            entries: Array.from({length: 12}, (_, index) => entry(index + 1, `lang-${index}`)),
            cursor: -5,
            nextVersion: 2,
        });
        expect(parsed?.entries).toHaveLength(CONFIG_HISTORY_LIMIT);
        expect(parsed?.entries[0]?.version).toBe(3);
        expect(parsed?.cursor).toBe(0);
        expect(parsed?.nextVersion).toBe(13);

        const defaults = parseConfigHistory({entries: [entry(9)]});
        expect(defaults).toMatchObject({cursor: 0, nextVersion: 10});
        const upperBound = parseConfigHistory({entries: [entry(1)], cursor: 99, nextVersion: 20});
        expect(upperBound).toMatchObject({cursor: 0, nextVersion: 20});

        const retainedCursor = parseConfigHistory({
            entries: Array.from({length: 12}, (_, index) => entry(index + 1)),
            cursor: 3,
            nextVersion: -2,
        });
        expect(retainedCursor).toMatchObject({cursor: 1, nextVersion: 13});

        const cursorAfterCorruptEntry = parseConfigHistory({
            entries: [entry(1), {version: 'bad'}, entry(2), entry(3)],
            cursor: 1,
        });
        expect(cursorAfterCorruptEntry).toMatchObject({cursor: 0, nextVersion: 4});
    });

    it('追加会去重、丢弃 redo 分支、限制容量并递增唯一版本', () => {
        const current = history();
        expect(appendConfigHistorySnapshot(current, {...baseConfig, to: 'en'}, 'same')).toBeNull();

        const branched = appendConfigHistorySnapshot(
            history({cursor: 0}),
            {...baseConfig, to: 'ja'},
            'branch-time',
        );
        expect(branched?.entries.map((item) => item.config.to)).toEqual(['zh-Hans', 'ja']);
        expect(branched).toMatchObject({cursor: 1, nextVersion: 4});
        expect(branched?.entries[1]).toMatchObject({version: 3, savedAt: 'branch-time'});

        let bounded = createBaselineConfigHistory(baseConfig, 1, 'baseline');
        for (let index = 0; index < 12; index += 1) {
            bounded = appendConfigHistorySnapshot(
                bounded,
                {...baseConfig, to: `target-${index}`},
                `time-${index}`,
            )!;
        }
        expect(bounded.entries).toHaveLength(CONFIG_HISTORY_LIMIT);
        expect(bounded.entries.at(-1)?.config.to).toBe('target-11');
    });

    it('可恢复投影排除凭据、统计、旧策略字段和内部迁移标记，恢复时保留当前值', () => {
        const snapshot = toRestorableConfig({
            ...baseConfig,
            to: 'ja',
            token: {openai: 'old-secret'},
            count: 2,
            persistCredentials: false,
            videoServiceDefaultMigrated: false,
        });
        expect(snapshot).not.toHaveProperty('token');
        expect(snapshot).not.toHaveProperty('count');
        expect(snapshot).not.toHaveProperty('persistCredentials');
        expect(snapshot).not.toHaveProperty('videoServiceDefaultMigrated');

        const restored = restoreRestorableConfig(snapshot, {
            ...baseConfig,
            to: 'en',
            token: {openai: 'current-secret'},
            count: 42,
            persistCredentials: true,
            videoServiceDefaultMigrated: true,
        });
        expect(restored).toMatchObject({
            to: 'ja',
            token: {openai: 'current-secret'},
            count: 42,
            videoServiceDefaultMigrated: true,
        });
        expect(restored).not.toHaveProperty('persistCredentials');

        const deepLxSnapshot = toRestorableConfig({
            ...baseConfig,
            videoService: 'deeplx',
            videoServiceDefaultMigrated: true,
        });
        expect(deepLxSnapshot.videoService).toBe('deeplx');
        expect(cloneConfigHistory(history({
            entries: [{...entry(1), config: deepLxSnapshot}],
            cursor: 0,
            nextVersion: 2,
        })).entries[0]?.config.videoService).toBe('deeplx');
        expect(restoreRestorableConfig(deepLxSnapshot, baseConfig).videoService).toBe('deeplx');
        expect(toRestorableConfig(null)).toMatchObject({videoService: ''});
    });

    it('恢复历史或自动备份时只保留仍绑定同一有效地址的 token', () => {
        const service = 'custom:history';
        const profile = (endpoint: string) => ({
            id: service,
            name: '历史服务',
            endpoint,
            models: ['history-model'],
        });
        const current = {
            ...baseConfig,
            service,
            customOpenAIProviders: [profile('https://current.example/v1/chat/completions')],
            model: {[service]: 'history-model'},
            token: {[service]: 'current-secret', openai: 'openai-secret'},
            proxy: {openai: 'https://current-openai-proxy.example/v1/chat/completions'},
        };

        const changedEndpoint = restoreRestorableConfig({
            ...baseConfig,
            service,
            customOpenAIProviders: [profile('https://restored.example/v1/chat/completions')],
            model: {[service]: 'history-model'},
            proxy: current.proxy,
        }, current);
        expect(changedEndpoint.token).not.toHaveProperty(service);
        expect(changedEndpoint.token.openai).toBe('openai-secret');

        const changedProxies = restoreRestorableConfig({
            ...baseConfig,
            service,
            customOpenAIProviders: current.customOpenAIProviders,
            model: {[service]: 'history-model'},
            proxy: {
                [service]: 'https://restored-custom-proxy.example/v1/chat/completions',
                openai: 'https://restored-openai-proxy.example/v1/chat/completions',
            },
        }, {
            ...current,
            proxy: {
                [service]: 'https://current-custom-proxy.example/v1/chat/completions',
                openai: 'https://current-openai-proxy.example/v1/chat/completions',
            },
        });
        expect(changedProxies.token).not.toHaveProperty(service);
        expect(changedProxies.token).not.toHaveProperty('openai');

        const stableProxy = 'https://stable-history-proxy.example/v1/chat/completions';
        const sameDestination = restoreRestorableConfig({
            ...baseConfig,
            service,
            customOpenAIProviders: [profile('https://restored-origin.example/v1/chat/completions')],
            model: {[service]: 'history-model'},
            proxy: {[service]: stableProxy},
        }, {
            ...current,
            proxy: {[service]: stableProxy},
        });
        expect(sameDestination.token[service]).toBe('current-secret');
    });

    it('恢复 legacy custom 的不同 endpoint 时不会复用当前 token', () => {
        const restored = restoreRestorableConfig({
            ...baseConfig,
            service: 'custom',
            custom: 'https://restored-legacy.example/v1/chat/completions',
            model: {custom: 'legacy-model'},
        }, {
            ...baseConfig,
            service: 'custom',
            custom: 'https://current-legacy.example/v1/chat/completions',
            model: {custom: 'legacy-model'},
            token: {custom: 'legacy-secret'},
        });

        expect(restored.token).not.toHaveProperty('custom');
    });

    it('历史恢复按真实 provider 路由处理 Gemini 与腾讯共享凭据', () => {
        const current = {
            ...baseConfig,
            proxy: {
                [services.gemini]: 'https://current-gemini-proxy.example/',
                [services.huanYuanTranslation]: 'https://current-hunyuan-proxy.example/',
            },
            token: {[services.gemini]: 'google-official-secret'},
            tencentSecretId: 'current-tencent-id',
            tencentSecretKey: 'current-tencent-key',
        };
        const restored = restoreRestorableConfig({
            ...baseConfig,
            proxy: {
                [services.gemini]: 'https://restored-gemini-proxy.example/',
                [services.huanYuanTranslation]: 'https://restored-hunyuan-proxy.example/',
            },
        }, current);

        expect(restored.token[services.gemini]).toBe('google-official-secret');
        expect(restored).toMatchObject({tencentSecretId: '', tencentSecretKey: ''});
    });

    it('撤销、重做和版本恢复在边界处保持稳定游标', () => {
        const state = history();
        expect(resolveConfigHistoryTargetIndex(state, 'undo')).toBe(0);
        expect(resolveConfigHistoryTargetIndex({...state, cursor: 0}, 'undo')).toBe(0);
        expect(resolveConfigHistoryTargetIndex({...state, cursor: 0}, 'redo')).toBe(1);
        expect(resolveConfigHistoryTargetIndex(state, 'redo')).toBe(1);
        expect(resolveConfigHistoryTargetIndex(state, 'restore')).toBe(1);
        expect(resolveConfigHistoryTargetIndex(state, 'restore', 1)).toBe(0);
        expect(() => resolveConfigHistoryTargetIndex(state, 'restore', 99)).toThrow('配置历史 v99 不存在');
    });
});


describe('设置历史的具体修改时间线', () => {
    it('最新记录比较上一次保存而不是当前配置，按新到旧展示字段旧值和新值', () => {
        const first = createBaselineConfigHistory(baseConfig, 40, '2026-10-03T04:59:01Z');
        const changed = appendConfigHistorySnapshot(first, {...baseConfig, to: 'en'}, '2026-10-03T04:59:09Z')!;
        const timeline = buildConfigHistoryTimeline(changed.entries);
        expect(timeline.map(item => item.version)).toEqual([41, 40]);
        expect(timeline[0].previousVersion).toBe(40);
        expect(timeline[0].diff?.groups[0].changes[0]).toMatchObject({key: 'to', before: '简体中文', after: 'English'});
        expect(timeline[1].diff).toBeNull();
        expect(timeline[1].previousVersion).toBeNull();
    });

    it('版本跳号和撤销游标不影响相邻快照的原始变更方向', () => {
        const state = history({entries: [entry(2), entry(7, 'en'), entry(9, 'ja')], cursor: 0});
        const timeline = buildConfigHistoryTimeline(state.entries);
        expect(timeline.map(item => item.previousVersion)).toEqual([7, 2, null]);
        expect(timeline[0].diff?.groups[0].changes[0]).toMatchObject({before: 'English', after: '日本語'});
        expect(state.cursor).toBe(0);
    });

    it('十条截断后的最早快照和单条基线不编造已丢失的修改', () => {
        expect(buildConfigHistoryTimeline([])).toEqual([]);
        const timeline = buildConfigHistoryTimeline([entry(39), entry(40, 'en')]);
        expect(timeline[1].diff).toBeNull();
        expect(buildConfigHistoryTimeline([entry(1)])[0].diff).toBeNull();
    });

    it('统计、迁移标记和凭据不会进入修改摘要，不改变源快照', () => {
        const before = {...baseConfig, count: 1, token: {openai: 'first-secret'}, customHeaders: {openai: 'Authorization: first-secret'},
            privacyProtectionSecretTerms: ['synthetic-private-term-before']};
        const after = {...baseConfig, count: 999, token: {openai: 'second-secret'}, customHeaders: {openai: 'Authorization: second-secret'},
            privacyProtectionSecretTerms: ['synthetic-private-term-after']};
        const source = [{...entry(1), config: before as never}, {...entry(2), config: after as never}];
        const original = JSON.stringify(source);
        const timeline = buildConfigHistoryTimeline(source);
        expect(timeline[0].diff?.changeCount).toBe(0);
        const serialized = JSON.stringify(timeline);
        for (const value of ['first-secret', 'second-secret', ...before.privacyProtectionSecretTerms, ...after.privacyProtectionSecretTerms]) {
            expect(serialized).not.toContain(value);
        }
        expect(timeline[0].config.privacyProtection.categories).toContain('secret');
        expect(JSON.stringify(source)).toBe(original);
    });

    it('多个分组的修改均可查看，重复快照明确返回零修改', () => {
        const first = createBaselineConfigHistory(baseConfig, 1);
        const changed = appendConfigHistorySnapshot(first, {...baseConfig, to: 'en', theme: 'dark', alwaysTranslateDomains: ['example.com']})!;
        const timeline = buildConfigHistoryTimeline(changed.entries);
        expect(timeline[0].diff?.changeCount).toBe(3);
        expect(timeline[0].diff?.groups.map(group => group.id)).toEqual(['general', 'siteRules']);
        expect(buildConfigHistoryTimeline([entry(1), entry(2)])[0].diff?.changeCount).toBe(0);
    });
});

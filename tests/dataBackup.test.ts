import {describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {
    FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE,
    FLUENTREAD_DATA_BACKUP_FORMAT,
    createFluentReadDataBackup,
    parseLocalDataImport,
    resolveBackupConfigCredentialMode,
    summarizeLocalDataImport,
    usesExactCredentialReplacement,
} from '@/src/features/settings/model/dataBackup';
import {
    VOCABULARY_BOOK_EXPORT_FORMAT,
    VOCABULARY_BOOK_EXPORT_VERSION,
    type VocabularyBookExport,
} from '@/src/features/vocabulary/public';
import {
    MODEL_USAGE_TRANSFER_FORMAT,
    MODEL_USAGE_TRANSFER_VERSION,
    type ModelUsageTransferDocument,
} from '@/src/services/model-usage/types';

function vocabulary(): VocabularyBookExport {
    return {
        format: VOCABULARY_BOOK_EXPORT_FORMAT,
        version: VOCABULARY_BOOK_EXPORT_VERSION,
        exportedAt: 100,
        includesPrivateContext: false,
        entries: [],
        reviewLogs: [],
    };
}

function modelUsage(): ModelUsageTransferDocument {
    return {
        format: MODEL_USAGE_TRANSFER_FORMAT,
        version: MODEL_USAGE_TRANSFER_VERSION,
        exportedAt: 100,
        events: [],
    };
}

describe('统一本机数据备份信封', () => {
    it.each([null, 'phrase', {}, [42], ['x'.repeat(257)], Array.from({length: 129}, () => 'phrase')])(
        '精确备份拒绝非法的自定义敏感词，不静默截断：%j', privacyProtectionSecretTerms => {
            const config = {...prepareConfigForExport(new Config()), privacyProtectionSecretTerms};
            expect(() => createFluentReadDataBackup({config, vocabulary: vocabulary(), modelUsage: modelUsage()})).toThrow('精确凭据快照');
        },
    );
    it('兼容旧备份缺省隐私词，并保留合法词条的完整快照', () => {
        const config = prepareConfigForExport(new Config());
        config.privacyProtectionSecretTerms = ['人工示例'];
        expect(createFluentReadDataBackup({config, vocabulary: vocabulary(), modelUsage: modelUsage()}).config.privacyProtectionSecretTerms).toEqual(['人工示例']);
        delete config.privacyProtectionSecretTerms;
        expect(() => createFluentReadDataBackup({config, vocabulary: vocabulary(), modelUsage: modelUsage()})).not.toThrow();
    });
    it('组合并识别配置、单词本与模型用量完整备份', () => {
        const config = new Config();
        config.translationLoadingStyle = 'orbit';
        const backup = createFluentReadDataBackup({
            config: prepareConfigForExport(config),
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
            exportedAt: 200,
        });
        expect(backup.config.translationLoadingStyle).toBe('orbit');

        expect(backup).toMatchObject({
            format: FLUENTREAD_DATA_BACKUP_FORMAT,
            version: 2,
            configCredentialMode: FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE,
            exportedAt: 200,
        });
        const parsed = parseLocalDataImport(JSON.parse(JSON.stringify(backup)));
        expect(parsed).toEqual({kind: 'complete', backup});
        if (parsed.kind === 'complete') {
            expect(usesExactCredentialReplacement(parsed.backup)).toBe(true);
            expect(resolveBackupConfigCredentialMode(parsed.backup)).toBe('replace');
            expect(parsed.backup.config.translationLoadingStyle).toBe('orbit');
        }
        expect(summarizeLocalDataImport(parsed)).toEqual({
            kind: 'complete',
            configIncluded: true,
            vocabularyEntries: 0,
            vocabularyReviewLogs: 0,
            modelUsageEvents: 0,
        });
    });

    it('旧 v1 完整备份保持兼容但不声明精确凭据替换', () => {
        const current = createFluentReadDataBackup({
            config: prepareConfigForExport(new Config()),
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
            exportedAt: 100,
        });
        const {configCredentialMode: _marker, ...legacy} = current;
        const parsed = parseLocalDataImport({...legacy, version: 1});

        expect(parsed.kind).toBe('complete');
        if (parsed.kind === 'complete') {
            expect(usesExactCredentialReplacement(parsed.backup)).toBe(false);
            expect(resolveBackupConfigCredentialMode(parsed.backup)).toBe('merge-hydration-safe');
        }
    });

    it('恢复早期 v2 备份时补齐后来新增的凭据字段，并保留原密钥与用户设置', () => {
        // 早期 v2 导出时尚未引入 secret、customHeaders 和 apiKeys。
        // 独立构造历史格式，避免跟随当前 Config 默认值掩盖兼容回归。
        const legacyConfig = {
            on: true, service: 'openai', display: 1, from: 'en', to: 'zh-CN',
            token: {openai: 'legacy-test-key'},
            ak: 'legacy-test-ak', sk: '', appid: '', key: '',
            youdaoAppKey: '', youdaoAppSecret: '', tencentSecretId: '', tencentSecretKey: '',
            extra: {},
            system_role: {openai: 'Keep this user-authored prompt.'},
        };
        const backup = {
            format: FLUENTREAD_DATA_BACKUP_FORMAT,
            version: 2,
            configCredentialMode: FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE,
            exportedAt: 100,
            config: legacyConfig,
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
        };
        const serialized = JSON.stringify(backup);
        const parsed = parseLocalDataImport(JSON.parse(serialized));
        expect(parsed.kind).toBe('complete');
        if (parsed.kind !== 'complete') throw new Error('未识别旧版完整备份');

        const current = new Config();
        current.apiKeys = {openai: ['current-test-key'], deepseek: ['current-other-test-key']};
        current.secret = {aliyunTranslation: 'current-test-secret'};
        current.customHeaders = {openai: '{"x-test-key":"current-test-header"}'};
        current.sk = 'current-test-sk';
        const credentialMode = resolveBackupConfigCredentialMode(parsed.backup);
        expect(credentialMode).toBe('replace');
        const restored = prepareConfigForImport(parsed.backup.config, current, {credentialMode});
        expect(restored.token).toEqual(legacyConfig.token);
        expect(restored.apiKeys).toEqual({openai: ['legacy-test-key']});
        expect(restored.secret).toEqual({});
        expect(restored.customHeaders).toEqual({});
        expect(restored.ak).toBe(legacyConfig.ak);
        expect(restored.sk).toBe('');
        expect(restored.system_role.openai).toBe(legacyConfig.system_role.openai);
        expect(JSON.stringify(parsed.backup)).toBe(serialized);

        const reexported = createFluentReadDataBackup({
            config: prepareConfigForExport(restored),
            vocabulary: parsed.backup.vocabulary,
            modelUsage: parsed.backup.modelUsage,
            exportedAt: 200,
        });
        expect(reexported.config).toMatchObject({secret: {}, customHeaders: {}, apiKeys: restored.apiKeys});
        expect(parseLocalDataImport(JSON.parse(JSON.stringify(reexported))).kind).toBe('complete');
    });

    it.each([undefined, null, [], 'invalid', {aliyunTranslation: 123}])(
        'v2 中显式提供的畸形 secret 不能当作旧版缺省值：%j', (secret) => {
            const backup = createFluentReadDataBackup({
                config: prepareConfigForExport(new Config()),
                vocabulary: vocabulary(),
                modelUsage: modelUsage(),
            });
            backup.config.secret = secret;
            expect(() => parseLocalDataImport(backup)).toThrow('精确凭据快照');
            expect(usesExactCredentialReplacement(backup)).toBe(false);
        },
    );

    it('v2 精确替换拒绝缺失或畸形凭据快照，v1 仍按旧协议兼容', () => {
        const complete = createFluentReadDataBackup({
            config: prepareConfigForExport(new Config()),
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
            exportedAt: 100,
        });
        const {token: _token, ...missingToken} = complete.config;

        expect(() => createFluentReadDataBackup({
            config: missingToken,
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
        })).toThrow('精确凭据快照');
        expect(() => parseLocalDataImport({...complete, config: missingToken}))
            .toThrow('精确凭据快照');
        expect(usesExactCredentialReplacement({...complete, config: missingToken})).toBe(false);
        expect(usesExactCredentialReplacement({...complete, config: null as never})).toBe(false);
        expect(usesExactCredentialReplacement({...complete, config: 'broken' as never})).toBe(false);
        expect(usesExactCredentialReplacement({...complete, config: [] as never})).toBe(false);
        expect(() => parseLocalDataImport({
            ...complete,
            config: {...complete.config, token: {openai: 123}},
        })).toThrow('精确凭据快照');
        expect(() => parseLocalDataImport({
            ...complete,
            config: {...complete.config, extra: null},
        })).toThrow('精确凭据快照');
        expect(() => parseLocalDataImport({
            ...complete,
            config: {...complete.config, ak: null},
        })).toThrow('精确凭据快照');

        const {configCredentialMode: _marker, ...legacy} = complete;
        const parsedLegacy = parseLocalDataImport({...legacy, version: 1, config: missingToken});
        expect(parsedLegacy.kind).toBe('complete');
        if (parsedLegacy.kind === 'complete') {
            expect(usesExactCredentialReplacement(parsedLegacy.backup)).toBe(false);
        }
    });

    it('兼容识别旧版单词本、模型用量与配置文件', () => {
        expect(parseLocalDataImport(vocabulary())).toEqual({kind: 'vocabulary', vocabulary: vocabulary()});
        expect(parseLocalDataImport(modelUsage())).toEqual({kind: 'model-usage', modelUsage: modelUsage()});

        const vocabularyWithRows = {
            ...vocabulary(),
            entries: [null as never],
            reviewLogs: [null as never],
        };
        expect(summarizeLocalDataImport({kind: 'vocabulary', vocabulary: vocabularyWithRows})).toEqual({
            kind: 'vocabulary',
            configIncluded: false,
            vocabularyEntries: 1,
            vocabularyReviewLogs: 1,
            modelUsageEvents: 0,
        });
        const modelUsageWithRows = {...modelUsage(), events: [null as never]};
        expect(summarizeLocalDataImport({kind: 'model-usage', modelUsage: modelUsageWithRows})).toEqual({
            kind: 'model-usage',
            configIncluded: false,
            vocabularyEntries: 0,
            vocabularyReviewLogs: 0,
            modelUsageEvents: 1,
        });

        const config = JSON.parse(JSON.stringify(prepareConfigForExport(new Config()))) as Record<string, unknown>;
        expect(parseLocalDataImport(config)).toEqual({kind: 'config', config});
        expect(summarizeLocalDataImport({kind: 'config', config})).toEqual({
            kind: 'config',
            configIncluded: true,
            vocabularyEntries: 0,
            vocabularyReviewLogs: 0,
            modelUsageEvents: 0,
        });
    });

    it('拒绝版本、配置或领域数据不完整的伪备份', () => {
        const config = prepareConfigForExport(new Config());
        expect(() => parseLocalDataImport(null)).toThrow('JSON 对象');
        expect(() => parseLocalDataImport([])).toThrow('JSON 对象');
        expect(() => parseLocalDataImport(new Date())).toThrow('JSON 对象');
        expect(() => parseLocalDataImport({format: FLUENTREAD_DATA_BACKUP_FORMAT, version: 3}))
            .toThrow('版本');
        expect(() => parseLocalDataImport({
            format: FLUENTREAD_DATA_BACKUP_FORMAT,
            version: 2,
            exportedAt: 100,
            config,
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
        })).toThrow('精确凭据快照标记');
        expect(() => createFluentReadDataBackup({config: {}, vocabulary: vocabulary(), modelUsage: modelUsage()}))
            .toThrow('配置');
        expect(() => parseLocalDataImport({
            format: FLUENTREAD_DATA_BACKUP_FORMAT,
            version: 1,
            exportedAt: 100,
            config,
            vocabulary: {...vocabulary(), entries: null},
            modelUsage: modelUsage(),
        })).toThrow('单词本');
        expect(() => parseLocalDataImport({format: 'unsupported'})).toThrow('不是受支持');
    });

    it('对创建时的单词本、模型用量和时间字段执行完整校验', () => {
        const config = prepareConfigForExport(new Config());
        const invalidVocabularyValues = [
            null,
            {...vocabulary(), format: 'other'},
            {...vocabulary(), version: 2},
            {...vocabulary(), exportedAt: '100'},
            {...vocabulary(), includesPrivateContext: 'false'},
            {...vocabulary(), entries: null},
            {...vocabulary(), reviewLogs: null},
        ] as unknown as VocabularyBookExport[];
        for (const invalidVocabulary of invalidVocabularyValues) {
            expect(() => createFluentReadDataBackup({
                config,
                vocabulary: invalidVocabulary,
                modelUsage: modelUsage(),
            })).toThrow('单词本');
        }

        const invalidModelUsageValues = [
            null,
            {...modelUsage(), format: 'other'},
            {...modelUsage(), version: 2},
            {...modelUsage(), exportedAt: '100'},
            {...modelUsage(), events: null},
        ] as unknown as ModelUsageTransferDocument[];
        for (const invalidModelUsage of invalidModelUsageValues) {
            expect(() => createFluentReadDataBackup({
                config,
                vocabulary: vocabulary(),
                modelUsage: invalidModelUsage,
            })).toThrow('模型用量');
        }

        expect(() => createFluentReadDataBackup({
            config,
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
            exportedAt: Number.POSITIVE_INFINITY,
        })).toThrow('导出时间');
        expect(() => createFluentReadDataBackup({
            config,
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
            exportedAt: -1,
        })).toThrow('导出时间');

        const now = vi.spyOn(Date, 'now').mockReturnValue(321);
        expect(createFluentReadDataBackup({config, vocabulary: vocabulary(), modelUsage: modelUsage()}).exportedAt)
            .toBe(321);
        now.mockRestore();
    });

    it('对完整备份的时间、配置和各领域严格拒绝失真数据', () => {
        const backup = createFluentReadDataBackup({
            config: prepareConfigForExport(new Config()),
            vocabulary: vocabulary(),
            modelUsage: modelUsage(),
            exportedAt: 100,
        });
        expect(() => parseLocalDataImport({...backup, exportedAt: Number.NaN})).toThrow('导出时间');
        expect(() => parseLocalDataImport({...backup, exportedAt: -1})).toThrow('导出时间');
        expect(() => parseLocalDataImport({...backup, config: {}})).toThrow('配置');
        expect(() => parseLocalDataImport({...backup, modelUsage: {...modelUsage(), events: null}}))
            .toThrow('模型用量');
    });

    it('接受无原型的标准 JSON 对象形状', () => {
        const nullPrototypeModel = Object.assign(Object.create(null), modelUsage()) as ModelUsageTransferDocument;
        const parsed = parseLocalDataImport(nullPrototypeModel);
        expect(parsed.kind).toBe('model-usage');
        if (parsed.kind === 'model-usage') expect(parsed.modelUsage).toBe(nullPrototypeModel);
    });
});

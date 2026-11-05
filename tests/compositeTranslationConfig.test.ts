import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    COMPOSITE_TRANSLATION_PROVIDER_ID_PREFIX,
    DEFAULT_COMPOSITE_TRANSLATION_TIMEOUT_MS,
    MAX_COMPOSITE_TRANSLATION_PROVIDER_NAME_LENGTH,
    createNextCompositeTranslationProviderId,
    getCompositeTranslationConfigFingerprint,
    getCompositeTranslationProvider,
    getCompositeTranslationServiceOptions,
    hasCompositeTranslationAIContext,
    isCompositeTranslationMemberService,
    isCompositeTranslationProviderId,
    isConfiguredCompositeTranslationProvider,
    normalizeCompositeTranslationProviders,
    normalizeCompositeTranslationStrategy,
    normalizeCompositeTranslationTimeoutMs,
    removeCompositeTranslationProvider,
    withCompositeTranslationServiceOptions,
    type CompositeTranslationProvider,
} from '@/src/core/config/compositeTranslation';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {services, servicesType} from '@/src/core/config/catalog';
import {normalizeInputBoxTranslationService} from '@/src/core/config/inputTranslation';
import {createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {projectDriveSyncConfig} from '@/src/core/config/driveSync';
import {createApiKeyRequirementKey} from '@/src/core/config/validation';
import {isConfigImportValid, prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';

const custom = {id: 'custom:work', name: '工作模型', endpoint: 'https://synthetic.example/v1', models: ['fixture-model']};
const provider = (patch: Partial<CompositeTranslationProvider> = {}): CompositeTranslationProvider => ({
    id: 'composite:work', name: '工作组合', strategy: 'sequential', services: ['google', custom.id], timeoutMs: 12_000, ...patch,
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('组合翻译公开配置', () => {
    it('只接受稳定完整身份并保留公开成员顺序，剔除重复、失效、嵌套和原型数据', () => {
        expect(COMPOSITE_TRANSLATION_PROVIDER_ID_PREFIX).toBe('composite:');
        for (const id of ['composite:1', 'composite:abc_DEF-2']) expect(isCompositeTranslationProviderId(id)).toBe(true);
        for (const id of [null, 1, 'custom:1', 'composite:', 'composite:bad value', `composite:${'x'.repeat(65)}`]) expect(isCompositeTranslationProviderId(id)).toBe(false);
        expect(normalizeCompositeTranslationProviders(null)).toEqual([]);
        expect(isCompositeTranslationMemberService(null)).toBe(false);
        expect(isCompositeTranslationMemberService('custom')).toBe(false);
        expect(isCompositeTranslationMemberService('custom:gone', [custom])).toBe(false);
        expect(isCompositeTranslationMemberService(custom.id, [custom])).toBe(true);
        expect(isCompositeTranslationMemberService('google')).toBe(true);
        expect(isCompositeTranslationMemberService('composite:work')).toBe(false);
        expect(normalizeCompositeTranslationProviders([
            null, false, [], Object.create({id: 'composite:inherited'}), {id: 1}, {id: 'wrong'},
            {id: ' composite:work ', name: ` ${'名'.repeat(90)} `, strategy: 'random', services: [' google ', custom.id, 'google', null, 'composite:other', 'custom:gone', 'ai'], timeoutMs: 99_000, token: 'discarded'},
            provider({name: '重复身份被忽略'}),
            Object.assign(Object.create({name: '不继承名称', strategy: 'smart', services: ['google']}), {id: 'composite:empty'}),
        ], [custom])).toEqual([
            provider({name: '名'.repeat(MAX_COMPOSITE_TRANSLATION_PROVIDER_NAME_LENGTH), strategy: 'random', timeoutMs: 45_000}),
            provider({id: 'composite:empty', name: '组合翻译 2', services: []}),
        ]);
        expect(normalizeCompositeTranslationProviders([{id: 'composite:empty', name: ' ', services: false}])).toEqual([provider({id: 'composite:empty', name: '组合翻译 1', services: []})]);
    });

    it('规范化三种策略和单成员预算，默认顺序 12 秒且上下界为 1–45 秒', () => {
        expect(normalizeCompositeTranslationStrategy('random')).toBe('random');
        expect(normalizeCompositeTranslationStrategy('smart')).toBe('smart');
        expect(normalizeCompositeTranslationStrategy('sequential')).toBe('sequential');
        expect(normalizeCompositeTranslationStrategy('unknown')).toBe('sequential');
        for (const value of [undefined, '12000', Infinity, NaN]) expect(normalizeCompositeTranslationTimeoutMs(value)).toBe(DEFAULT_COMPOSITE_TRANSLATION_TIMEOUT_MS);
        expect(normalizeCompositeTranslationTimeoutMs(-10)).toBe(1000);
        expect(normalizeCompositeTranslationTimeoutMs(13_456.9)).toBe(13_456);
        expect(normalizeCompositeTranslationTimeoutMs(99_999)).toBe(45_000);
    });

    it('目录保留用户名称，不把混合组合错误分类为 AI，删除返回独立成员数组', () => {
        const item = provider();
        expect(getCompositeTranslationProvider([item], item.id)).toBe(item);
        expect(getCompositeTranslationProvider(undefined, item.id)).toBeUndefined();
        expect(isConfiguredCompositeTranslationProvider([item], item.id)).toBe(true);
        expect(isConfiguredCompositeTranslationProvider([item], 'composite:missing')).toBe(false);
        expect(getCompositeTranslationServiceOptions(undefined)).toEqual([]);
        expect(getCompositeTranslationServiceOptions([item, provider({strategy: 'random'}), provider({strategy: 'smart'})]).map(option => option.description)).toEqual(['轮流 · 2 个翻译服务', '随机 · 2 个翻译服务', '智能 · 2 个翻译服务']);
        expect(withCompositeTranslationServiceOptions([{value: 'google', label: 'Google'}, {value: item.id, label: '旧目录'}], [item])).toEqual([{value: 'google', label: 'Google'}, ...getCompositeTranslationServiceOptions([item])]);
        expect(withCompositeTranslationServiceOptions([], undefined)).toEqual([]);
        expect(servicesType.isAI(item.id)).toBe(false);
        expect(removeCompositeTranslationProvider(undefined, item.id)).toEqual([]);
        const kept = removeCompositeTranslationProvider([item, provider({id: 'composite:other'})], 'composite:other');
        expect(kept).toEqual([item]);
        kept[0].services.push('microsoft');
        expect(item.services).toEqual(['google', custom.id]);
    });

    it('生成高熵稳定身份，重试冲突且禁止身份截断和复用', () => {
        const item = provider();
        const suffix = vi.fn().mockReturnValueOnce('work').mockReturnValueOnce('bad value').mockReturnValueOnce(null).mockReturnValueOnce(' unique ');
        expect(createNextCompositeTranslationProviderId([item], suffix)).toBe('composite:unique');
        expect(suffix).toHaveBeenCalledTimes(4);
        expect(() => createNextCompositeTranslationProviderId([item], () => 'work')).toThrow('无法生成唯一的组合翻译服务 ID');
        vi.stubGlobal('crypto', {randomUUID: () => 'uuid-fixture'});
        expect(createNextCompositeTranslationProviderId(undefined)).toBe('composite:uuid-fixture');
        vi.stubGlobal('crypto', undefined);
        vi.spyOn(Date, 'now').mockReturnValue(100);
        vi.spyOn(Math, 'random').mockReturnValue(0.25);
        const first = createNextCompositeTranslationProviderId(undefined);
        expect(isCompositeTranslationProviderId(first)).toBe(true);
        expect(createNextCompositeTranslationProviderId(undefined)).not.toBe(first);
    });

    it('配置所有翻译入口可选组合，删除组合和自定义成员时精确清理引用', () => {
        expect(new Config().compositeTranslationProviders).toEqual([]);
        const item = provider();
        const normalized = normalizeConfig({customOpenAIProviders: [custom], compositeTranslationProviders: [item], service: item.id,
            documentService: item.id, videoService: item.id, hoverTranslationService: item.id, selectionTranslationService: item.id,
            imageTranslationService: item.id, areaTranslationService: item.id, inputBoxTranslationService: item.id,
            favoriteServices: [item.id, 'composite:missing'], translationCenterServices: [item.id, 'composite:missing'],
            quickTranslationProfiles: [{id: 'quick:combo', action: 'full-page', enabled: true, service: item.id}],
        });
        for (const field of ['service', 'documentService', 'videoService', 'hoverTranslationService', 'selectionTranslationService', 'imageTranslationService', 'areaTranslationService', 'inputBoxTranslationService'] as const) expect(normalized[field]).toBe(item.id);
        expect(normalized.favoriteServices).toEqual([item.id]);
        expect(normalized.translationCenterServices).toEqual([item.id]);
        expect(normalized.quickTranslationProfiles[0].service).toBe(item.id);
        expect(normalizeInputBoxTranslationService(item.id, [], [item])).toBe(item.id);
        expect(normalizeInputBoxTranslationService('composite:missing', [], [item])).toBe('');
        expect(normalizeConfig({...normalized, customOpenAIProviders: []}).compositeTranslationProviders[0].services).toEqual(['google']);
        const deleted = normalizeConfig({...normalized, compositeTranslationProviders: []});
        expect(deleted.service).toBe(new Config().service);
        for (const field of ['documentService', 'videoService', 'hoverTranslationService', 'selectionTranslationService', 'imageTranslationService', 'areaTranslationService', 'inputBoxTranslationService'] as const) expect(deleted[field]).toBe('');
        expect(deleted.favoriteServices).toEqual([]);
        expect(deleted.translationCenterServices).toEqual([]);
        expect(deleted.quickTranslationProfiles[0].service).toBe('');
        expect(normalizeConfig({compositeTranslationProviders: [provider({services: []})], service: item.id}).service).toBe(item.id);
    });

    it('异步请求快照深度复制冻结公开组合，云端普通设置只包含公开组合字段', () => {
        const config = normalizeConfig({compositeTranslationProviders: [provider()], customOpenAIProviders: [custom], token: {[custom.id]: 'synthetic-local-secret'}});
        const snapshot = createTranslationProviderConfigSnapshot(config);
        config.compositeTranslationProviders[0].strategy = 'smart';
        config.compositeTranslationProviders[0].services[0] = 'microsoft';
        expect(snapshot.compositeTranslationProviders?.[0]).toEqual(provider());
        expect(Object.isFrozen(snapshot.compositeTranslationProviders)).toBe(true);
        expect(Object.isFrozen(snapshot.compositeTranslationProviders?.[0])).toBe(true);
        expect(Object.isFrozen(snapshot.compositeTranslationProviders?.[0].services)).toBe(true);
        expect(createTranslationProviderConfigSnapshot({...config, compositeTranslationProviders: undefined}).compositeTranslationProviders).toEqual([]);
        const projected = projectDriveSyncConfig(config as unknown as Record<string, unknown>);
        expect(projected.compositeTranslationProviders).toEqual(config.compositeTranslationProviders);
        expect(projected.token).toBeUndefined();
        expect(projected.customOpenAIProviders).toBeUndefined();
        expect(JSON.stringify(projected.compositeTranslationProviders)).not.toContain('synthetic-local-secret');
    });

    it('以组合为默认服务的导出可再导入；导入只接受文件自有且已保存的组合身份', () => {
        const current = normalizeConfig({service: provider().id, compositeTranslationProviders: [provider()], customOpenAIProviders: [custom]});
        const exported = prepareConfigForExport(current);
        expect(isConfigImportValid(exported)).toBe(true);
        expect(prepareConfigForImport(exported, new Config()).service).toBe(provider().id);
        expect(isConfigImportValid({...exported, compositeTranslationProviders: undefined})).toBe(false);
        expect(isConfigImportValid({...exported, compositeTranslationProviders: []})).toBe(false);
        const inherited = Object.assign(Object.create({compositeTranslationProviders: [provider()]}), exported);
        delete inherited.compositeTranslationProviders;
        expect(isConfigImportValid(inherited)).toBe(false);
        expect(isConfigImportValid({...exported, customOpenAIProviders: undefined})).toBe(true);
        const customInherited = Object.assign(Object.create({customOpenAIProviders: [custom]}), exported);
        delete customInherited.customOpenAIProviders;
        expect(isConfigImportValid(customInherited)).toBe(true);
    });

    it('成员连接变更只产生安全摘要，不关联无关服务或用户名字', () => {
        const config = new Config();
        config.customOpenAIProviders = [custom];
        config.compositeTranslationProviders = [provider()];
        config.token[custom.id] = 'synthetic-private-fixture';
        config.requireApiKey = {[custom.id]: true, [`${custom.id}:model`]: false, [createApiKeyRequirementKey(custom.id, 'fixture')]: false, unknown: true};
        const initial = getCompositeTranslationConfigFingerprint(config, provider().id)!;
        expect(initial).toMatch(/^composite-v1:[0-9a-f]{64}$/);
        expect(initial).not.toContain('synthetic-private-fixture');
        config.token.openai = 'unrelated';
        config.compositeTranslationProviders[0].name = '新名称';
        expect(getCompositeTranslationConfigFingerprint(config, provider().id)).toBe(initial);
        for (const mutation of [
            () => {config.compositeTranslationProviders[0].strategy = 'smart';},
            () => {config.compositeTranslationProviders[0].services.reverse();},
            () => {config.compositeTranslationProviders[0].timeoutMs += 1000;},
            () => {config.model[custom.id] = 'changed';},
            () => {config.customModel[custom.id] = 'custom-changed';},
            () => {config.customOpenAIProviders[0].endpoint += '/changed';},
            () => {config.customBody[custom.id] = '{"temperature":0}';},
            () => {config.system_role[custom.id] = 'changed';},
            () => {config.user_role[custom.id] = 'changed';},
            () => {config.customHeaders[custom.id] = '{"x-test":"changed"}';},
            () => {config.serviceRegion[custom.id] = 'changed';},
            () => {config.nativeBatchTranslationEnabled[custom.id] = false;},
            () => {config.modelThinking[custom.id] = {changed: true};},
            () => {config.token[custom.id] = 'changed-secret';},
            () => {config.apiKeys[custom.id] = ['changed-secret'];},
        ]) {
            const before = getCompositeTranslationConfigFingerprint(config, provider().id);
            mutation();
            expect(getCompositeTranslationConfigFingerprint(config, provider().id)).not.toBe(before);
        }
        expect(getCompositeTranslationConfigFingerprint(config, 'google')).toBeUndefined();
        expect(getCompositeTranslationConfigFingerprint({}, 'composite:missing')).toMatch(/^composite-v1:[0-9a-f]{64}$/);
        const memberServices = [services.custom, services.newapi, services.azureOpenai, services.deeplx, services.myMemory, services.youdao,
            services.tencent, services.deepL, services.freeTranslation, services.minimax, services.mimo, services.deepseek, services.google];
        expect(getCompositeTranslationConfigFingerprint({compositeTranslationProviders: [provider({services: memberServices})]}, provider().id)).toMatch(/^composite-v1:[0-9a-f]{64}$/);
    });

    it('只有实际通用提示词 AI 成员启用组合上下文，不把原生 MT 模型提升为 AI', () => {
        const config = new Config();
        expect(hasCompositeTranslationAIContext(config, 'google')).toBe(false);
        expect(hasCompositeTranslationAIContext({}, 'composite:missing')).toBe(false);
        config.compositeTranslationProviders = [provider({services: ['google', 'tongyi']})];
        config.model.tongyi = 'qwen-mt-plus';
        expect(hasCompositeTranslationAIContext(config, provider().id)).toBe(false);
        config.model.tongyi = 'qwen-plus';
        expect(hasCompositeTranslationAIContext(config, provider().id)).toBe(true);
        config.disabledTranslationServices = ['tongyi'];
        expect(hasCompositeTranslationAIContext(config, provider().id)).toBe(false);
        config.disabledTranslationServices = [];
        expect(hasCompositeTranslationAIContext(config, provider().id)).toBe(true);
        expect(hasCompositeTranslationAIContext({compositeTranslationProviders: [provider({services: ['google', 'openai']})]}, provider().id)).toBe(true);
    });
});

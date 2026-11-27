/**
 * @file tests/configCatalogSplit.test.ts
 * 文件职责：验证 src/core/config/catalog 与 src/core/config/model 拆分后的门面符号一致性与独立子模块边界。
 * 主要内容：核对 catalog 门面与七个子模块的精确引用等价、关键服务/保留模型常量与外部域模块保持一致，以及地域、语言标签、默认模型与提示词目录的边界行为。
 * 模块边界：仅做纯内存与静态模块校验，不读写浏览器存储或访问网络。
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import * as catalog from '@/src/core/config/catalog';
import * as catalogModels from '@/src/core/config/catalog/models';
import * as catalogOptions from '@/src/core/config/catalog/options';
import * as catalogPrompts from '@/src/core/config/catalog/prompts';
import * as catalogRegions from '@/src/core/config/catalog/regions';
import * as catalogServices from '@/src/core/config/catalog/services';
import * as catalogServiceTypes from '@/src/core/config/catalog/serviceTypes';
import * as catalogTargetLabels from '@/src/core/config/catalog/targetLanguageLabels';
import {CUSTOM_OPENAI_RESERVED_MODEL_ID} from '@/src/core/config/customOpenAI';
import {LOCAL_TRANSLATION_SERVICE_ID} from '@/src/core/config/localTranslation';
import * as model from '@/src/core/config/model';
import {Config} from '@/src/core/config/model/configClass';
import * as interactionDefaults from '@/src/core/config/model/interactionDefaults';
import {migrateModelIdentifier} from '@/src/core/config/model/modelMigration';
import {normalizeConfig} from '@/src/core/config/model/normalizeConfig';

describe('config catalog and model barrel decomposition', () => {
    it('keeps catalog barrel exports identical to submodule exports and aligned with leaf constants', () => {
        expect(catalog.services).toBe(catalogServices.services);
        expect(catalog.cloudCredentialLabels).toBe(catalogServices.cloudCredentialLabels);
        expect(catalog.getCloudCredentialLabels).toBe(catalogServices.getCloudCredentialLabels);
        expect(catalog.cloudVendorServices).toBe(catalogServices.cloudVendorServices);
        expect(catalog.referenceAiPlatformServices).toBe(catalogServices.referenceAiPlatformServices);
        expect(catalog.customModelString).toBe(catalogServices.customModelString);
        expect(catalog.resolveConfiguredModel).toBe(catalogServices.resolveConfiguredModel);
        expect(catalog.servicesType).toBe(catalogServiceTypes.servicesType);
        expect(catalog.cloudRegionOptions).toBe(catalogRegions.cloudRegionOptions);
        expect(catalog.getDefaultCloudRegion).toBe(catalogRegions.getDefaultCloudRegion);
        expect(catalog.resolveCloudRegion).toBe(catalogRegions.resolveCloudRegion);
        expect(catalog.minimaxBillingPlans).toBe(catalogRegions.minimaxBillingPlans);
        expect(catalog.minimaxRegions).toBe(catalogRegions.minimaxRegions);
        expect(catalog.mimoBillingPlans).toBe(catalogRegions.mimoBillingPlans);
        expect(catalog.mimoRegions).toBe(catalogRegions.mimoRegions);
        expect(catalog.currentModelIds).toBe(catalogModels.currentModelIds);
        expect(catalog.defaultModelIds).toBe(catalogModels.defaultModelIds);
        expect(catalog.models).toBe(catalogModels.models);
        expect(catalog.firstConfiguredModel).toBe(catalogModels.firstConfiguredModel);
        expect(catalog.defaultModels).toBe(catalogModels.defaultModels);
        expect(catalog.options).toBe(catalogOptions.options);
        expect(catalog.multilingualTargetLanguageLabels).toBe(catalogTargetLabels.multilingualTargetLanguageLabels);
        expect(catalog.englishTargetLanguageLabels).toBe(catalogTargetLabels.englishTargetLanguageLabels);
        expect(catalog.getMultilingualTargetLanguageLabel).toBe(catalogTargetLabels.getMultilingualTargetLanguageLabel);
        expect(catalog.LEGACY_DEFAULT_USER_ROLES).toBe(catalogPrompts.LEGACY_DEFAULT_USER_ROLES);
        expect(catalog.defaultOption).toBe(catalogPrompts.defaultOption);

        expect(catalog.services.localTranslation).toBe(LOCAL_TRANSLATION_SERVICE_ID);
        expect(catalog.customModelString).toBe(CUSTOM_OPENAI_RESERVED_MODEL_ID);
    });

    it('keeps model barrel exports identical to submodule exports', () => {
        expect(model.Config).toBe(Config);
        expect(model.normalizeConfig).toBe(normalizeConfig);
        expect(model.migrateModelIdentifier).toBe(migrateModelIdentifier);
        expect(model.normalizeFloatingBallMargin).toBe(interactionDefaults.normalizeFloatingBallMargin);
        expect(model.normalizeVideoSubtitleOffsetMs).toBe(interactionDefaults.normalizeVideoSubtitleOffsetMs);
    });

    it('covers region, label, and configured-model helpers across known and unknown keys', () => {
        expect(catalog.resolveConfiguredModel(catalog.customModelString, 'my-model')).toBe('my-model');
        expect(catalog.resolveConfiguredModel(catalog.customModelString, '')).toBe('');
        expect(catalog.resolveConfiguredModel('gpt-5.4-mini', 'ignored')).toBe('gpt-5.4-mini');
        expect(catalog.resolveConfiguredModel(undefined, 'ignored')).toBe('');

        expect(catalog.resolveCloudRegion(catalog.services.aliyunTranslation, 'ap-southeast-1')).toBe('ap-southeast-1');
        expect(catalog.resolveCloudRegion(catalog.services.aliyunTranslation, 'invalid')).toBe('cn-hangzhou');
        expect(catalog.resolveCloudRegion('unknown', 'ap-southeast-1')).toBe('');
        expect(catalog.getDefaultCloudRegion('unknown')).toBe('');

        expect(catalog.getMultilingualTargetLanguageLabel('zh-CN')).toBe(catalog.multilingualTargetLanguageLabels['zh-Hans']);
        expect(catalog.getMultilingualTargetLanguageLabel('en', 'en', 'en-US')).toBe('English');
        expect(catalog.getMultilingualTargetLanguageLabel('en', 'en', 'ja-JP')).toContain('英語');
        expect(catalog.getMultilingualTargetLanguageLabel('unknown-lang', 'fallback', 'en-US')).toBe('fallback');
        expect(catalog.getMultilingualTargetLanguageLabel('en', 'en', 'unknown-ui')).toBe(catalog.multilingualTargetLanguageLabels.en);
    });

    it('covers cross-domain normalization branches in normalizeConfig and providerNormalization', () => {
        // Custom input-box hotkey fallback, bilibili insertion without microsoft, cloud regions, orphan request limits, composite service
        const normalized = model.normalizeConfig({
            inputBoxTranslationTrigger: 'custom',
            customInputBoxTranslationHotkey: '',
            freeTranslationOrder: ['google'],
            freeTranslationBilibiliDefaultApplied: false,
            serviceRegion: {aliyunTranslation: 'ap-southeast-1', unknownService: 'eastus'},
            serviceRequestLimits: {'custom:orphan': {requestsPerSecond: 1}, openai: {requestsPerSecond: 2}},
            modelRequestLimits: {'custom:orphan': {m1: {requestsPerSecond: 1}}, openai: {'gpt-5.4-mini': {requestsPerSecond: 2}}},
            compositeTranslationProviders: [{id: 'composite:mix', name: 'Mix', strategy: 'random', services: ['google', 'microsoft']}],
            service: 'composite:mix',
            videoSubtitleModeHotkeyEnabled: null as unknown as boolean,
            videoSubtitleModeHotkey: 'custom',
            customVideoSubtitleModeHotkey: '',
            selectionTranslatorMode: 'disabled',
            selectionTranslatorModeBeforeDisable: 'translation-only',
        });
        expect(normalized.inputBoxTranslationTrigger).toBe('disabled');
        expect(normalized.freeTranslationOrder[0]).toBe('bilibiliFree');
        expect(normalized.serviceRegion).toEqual({aliyunTranslation: 'ap-southeast-1'});
        expect(normalized.serviceRequestLimits).not.toHaveProperty('custom:orphan');
        expect(normalized.modelRequestLimits).not.toHaveProperty('custom:orphan');
        expect(normalized.service).toBe('composite:mix');
        expect(normalized.videoSubtitleModeHotkeyEnabled).toBe(false);
        expect(normalized.videoSubtitleModeHotkey).toBe('Alt+M');
        expect(normalized.selectionTranslatorModeBeforeDisable).toBe('translation-only');

        // Video subtitle hotkey enabled branch in reservedHotkeys & legacy harness migration (shortcut, hover, icon)
        const withVideoHotkey = model.normalizeConfig({
            videoSubtitleModeHotkeyEnabled: true,
            selectionTranslatorMode: 'disabled',
            harness: {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+H'},
        });
        expect(withVideoHotkey.selectionTranslatorMode).toBe('bilingual');
        expect(withVideoHotkey.selectionTranslatorTrigger).toBe('custom');
        expect(withVideoHotkey.customSelectionTranslatorHotkey).toBe('Alt+H');

        const withHoverHarness = model.normalizeConfig({
            selectionTranslatorMode: 'disabled',
            harness: {enabled: true, trigger: 'hover'},
        });
        expect(withHoverHarness.selectionTranslatorTrigger).toBe('hover');

        const withIconHarness = model.normalizeConfig({
            selectionTranslatorMode: 'disabled',
            harness: {enabled: true, trigger: 'icon'},
        });
        expect(withIconHarness.selectionTranslatorTrigger).toBe('icon');

        // ChatGPT plan thinking + dictionary custom header pruning + quickTranslationProfiles callbacks
        const withPlanAndDict = model.normalizeConfig({
            service: 'openai',
            model: {chatgptPlan: 'gpt-5-plan'},
            modelThinking: {chatgptPlan: {'gpt-5-plan': true}},
            selectionDictionaryWorkspace: {
                recipes: [{
                    id: 'rec1',
                    name: 'R1',
                    kind: 'json',
                    url: 'https://dict.test/{{word}}',
                    headers: {},
                    fields: {definition: '', phonetic: '', audio: '', example: '', etymology: '', inflections: ''},
                    script: '',
                    localId: '',
                }],
            },
            selectionDictionaryRecipe: 'rec1',
            customHeaders: {'dictionary:rec1': '{"X-A":"1"}', 'dictionary:orphan': '{"X-B":"2"}'},
            quickTranslationProfiles: [{
                id: 'qp1',
                name: 'Quick',
                scope: 'page',
                hotkey: 'Alt+P',
                service: 'openai',
                model: 'gpt-5.4-mini',
                to: 'en',
            }],
        });
        expect(withPlanAndDict.model.chatgptPlan).toBe('gpt-5-plan');
        expect(withPlanAndDict.modelThinking.chatgptPlan).toEqual({'gpt-5-plan': true});
        expect(withPlanAndDict.customHeaders).toHaveProperty('dictionary:rec1');
        expect(withPlanAndDict.customHeaders).not.toHaveProperty('dictionary:orphan');
        expect(Array.isArray(withPlanAndDict.quickTranslationProfiles)).toBe(true);

        // Userscript environment omits extension-only dictionary & personalCorrections fields
        vi.stubEnv('BROWSER', 'userscript');
        try {
            const userscriptDefault = new model.Config();
            expect('personalCorrectionsEnabled' in userscriptDefault).toBe(false);
            const userscriptNormalized = model.normalizeConfig({personalCorrectionsEnabled: true});
            expect('personalCorrectionsEnabled' in userscriptNormalized).toBe(false);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

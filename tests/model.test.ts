import { describe, expect, it } from 'vitest';

import {
    Config,
    DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY,
    DEFAULT_FLOATING_BALL_HOVER_DELAY,
    DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY,
    DEFAULT_SELECTION_TRANSLATOR_DELAY,
    FLOATING_BALL_COLLAPSED_OPACITY_MAX,
    FLOATING_BALL_COLLAPSED_OPACITY_MIN,
    FLOATING_BALL_HOVER_DELAY_MAX,
    FLOATING_BALL_HOVER_DELAY_MIN,
    MOUSE_HOVER_TRANSLATION_DELAY_MAX,
    MOUSE_HOVER_TRANSLATION_DELAY_MIN,
    SELECTION_TRANSLATOR_DELAY_MAX,
    SELECTION_TRANSLATOR_DELAY_MIN,
    normalizeConfig,
    normalizeFloatingBallClickAction,
    normalizeFloatingBallCollapsedOpacity,
    normalizeFloatingBallHoverDelay,
    normalizeFloatingBallToolsDisplay,
} from '@/src/core/config/model';
import { getMimoEndpoint, MIMO_ENDPOINTS, MINIMAX_ENDPOINTS, tongyiTokenPlanUrl, urls } from '@/src/core/config/constants';

import { currentModelIds, customModelString, defaultModelIds, defaultModels, defaultOption, LEGACY_DEFAULT_USER_ROLES, models, options, resolveConfiguredModel, services, servicesType } from '@/src/core/config/catalog';
import {
    CUSTOM_OPENAI_RESERVED_MODEL_ID,
    MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER,
} from '@/src/core/config/customOpenAI';
import {
    MAX_QUICK_TRANSLATION_MODEL_LENGTH,
    MAX_QUICK_TRANSLATION_PROFILES,
} from '@/src/core/config/quickTranslation';
import {createApiKeyRequirementKey} from '@/src/core/config/validation';

describe('中英双向划词配置', () => {
    it('默认关闭，只有明确的布尔 true 才启用', () => {
        expect(new Config().selectionTranslatorBidirectional).toBe(false);
        expect(normalizeConfig({}).selectionTranslatorBidirectional).toBe(false);
        expect(normalizeConfig({selectionTranslatorBidirectional: true}).selectionTranslatorBidirectional).toBe(true);
        expect(normalizeConfig({selectionTranslatorBidirectional: 'true' as unknown as boolean}).selectionTranslatorBidirectional).toBe(false);
    });
});

describe('AI 模型编号列表', () => {
    it('DeepL API 旧配置保持 Free 端点，并持久保留明确选择的 Pro 套餐', () => {
        expect(new Config().deeplApiPlan).toBe('free');
        expect(normalizeConfig({}).deeplApiPlan).toBe('free');
        expect(normalizeConfig({deeplApiPlan: 'free'}).deeplApiPlan).toBe('free');
        expect(normalizeConfig({deeplApiPlan: 'pro'}).deeplApiPlan).toBe('pro');
        for (const deeplApiPlan of ['paid', 'PRO', '', null, 1, {}, []]) {
            expect(normalizeConfig({deeplApiPlan}).deeplApiPlan).toBe('free');
        }
    });

    it('翻译计数只保留非负安全整数，并清理畸形旧值', () => {
        expect(normalizeConfig({count: 12}).count).toBe(12);
        expect(normalizeConfig({count: 0}).count).toBe(0);
        for (const count of [-1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
            expect(normalizeConfig({count}).count).toBe(0);
        }
        expect(normalizeConfig({__fluentCountOperations: [{id: 'private-operation'}]}))
            .not.toHaveProperty('__fluentCountOperations');
    });

    it('移除旧版凭据持久化策略字段，统一由当前存储策略管理', () => {
        expect(new Config()).not.toHaveProperty('persistCredentials');
        expect(normalizeConfig({})).not.toHaveProperty('persistCredentials');
        expect(normalizeConfig({persistCredentials: true})).not.toHaveProperty('persistCredentials');
        expect(normalizeConfig({persistCredentials: false})).not.toHaveProperty('persistCredentials');
        expect(normalizeConfig({persistCredentials: 'true'})).not.toHaveProperty('persistCredentials');
    });

    it('移除已退役的 X 原生翻译配置，不让旧开关进入历史或迁移导出', () => {
        expect(new Config()).not.toHaveProperty('xGrokAutoTranslateEnabled');
        expect(normalizeConfig({xGrokAutoTranslateEnabled: true}))
            .not.toHaveProperty('xGrokAutoTranslateEnabled');
        expect(normalizeConfig({xGrokAutoTranslateEnabled: false}))
            .not.toHaveProperty('xGrokAutoTranslateEnabled');
    });

    it('AI 智能上下文默认关闭，并能从旧配置平滑补齐', () => {
        expect(new Config().enableAIContext).toBe(false);
        expect(normalizeConfig({}).enableAIContext).toBe(false);
        expect(normalizeConfig({enableAIContext: true}).enableAIContext).toBe(true);
        expect(servicesType.isUseAIContext(services.openai)).toBe(true);
        expect(servicesType.isUseAIContext(services.microsoft)).toBe(false);
        expect(servicesType.isUseAIContext(services.huanYuanTranslation)).toBe(false);
        expect(servicesType.isUseAIContext(services.tongyi, 'qwen-mt-plus')).toBe(false);
        expect(servicesType.isUseAIContext(services.tongyi, resolveConfiguredModel(customModelString, 'qwen-mt-plus'))).toBe(false);
        expect(resolveConfiguredModel(customModelString, 'custom-model')).toBe('custom-model');
    });

    it('AI 多段翻译默认关闭，并只接受显式布尔值开启', () => {
        expect(new Config().enableAIMultiSegment).toBe(false);
        expect(normalizeConfig({}).enableAIMultiSegment).toBe(false);
        expect(normalizeConfig({enableAIMultiSegment: true}).enableAIMultiSegment).toBe(true);
        expect(normalizeConfig({enableAIMultiSegment: 'true'}).enableAIMultiSegment).toBe(false);
    });

    it('展示当前主流模型，并移除已退役或错误的预设编号', () => {
        expect(models.get(services.openai)?.at(0)).toBe('gpt-5.4-mini');
        expect(models.get(services.openai)).toContain('gpt-5.6-sol');
        expect(models.get(services.openai)).not.toContain('gpt5');
        expect(models.get(services.gemini)).toContain('gemini-3.6-flash');
        expect(models.get(services.claude)).toContain('claude-fable-5');
        expect(models.get(services.claude)).toContain('claude-sonnet-5');
        expect(models.get(services.claude)?.at(-1)).toBe(customModelString);
        expect(models.get(services.tongyi)?.at(0)).toBe('qwen3.8-flash');
        expect(models.get(services.tongyi)).toContain('qwen3.7-max');
        expect(models.get(services.tongyi)).toContain('qwen3.7-flash');
        expect(models.get(services.zhipu)?.at(0)).toBe('glm-4.5-flash');
        expect(models.get(services.zhipu)).toContain('glm-5.2');
        expect(models.get(services.infini)).toContain('glm-5.2');
        expect(models.get(services.infini)).not.toContain('glm-5.3');
        expect(models.get(services.moonshot)).toContain('kimi-k2.7-code');
        expect(models.get(services.yiyan)).toContain('ernie-5.1');
        expect(models.get(services.minimax)).toContain('MiniMax-M2.7');
        expect(models.get(services.minimax)).toContain('MiniMax-M3');
        expect(models.get(services.minimax)).toContain('MiniMax-M3.1-flash');
        expect(models.get(services.mimo)).toEqual([
            'mimo-v2.6-flash', 'mimo-v2.6-pro', customModelString,
        ]);
        expect(models.get(services.jieyue)).toContain('step-3.5-flash');
        expect(models.get(services.huanYuan)).toContain('hy3');
        expect(models.get(services.grok)).toContain('grok-4.5');
        expect(models.get(services.groq)).not.toContain('whisper-large-v3');
        expect(models.get(services.openrouter)?.at(-1)).toBe(customModelString);
        expect(options.services.find(option => option.value === services.zhipu)?.label).toBe('智谱/GLM');
        expect(options.services.find(option => option.value === services.moonshot)?.label).toBe('月之暗面/Kimi');
        expect(options.services.find(option => option.value === services.tongyi)?.label).toBe('千问/Qwen');
        expect(options.services.find(option => option.value === services.freeTranslation)?.label).toBe('免费翻译服务');
        expect(options.services[1]?.value).toBe(services.freeTranslation);
        expect(options.services.find(option => option.value === services.freeTranslation)?.description)
            .toContain('后台自动均衡可用服务');
        expect(options.services.find(option => option.value === services.mimo)?.label).toBe('小米 MiMo');
        expect(options.services.some(option => option.value === services.baichuan)).toBe(false);
        expect(options.services.some(option => option.value === services.lingyi)).toBe(false);
        expect(options.services.find(option => option.value === services.infini)?.label).toBe('无问芯穹');
        expect(options.services.every(option => !/[🌟⭐★]/u.test(option.label))).toBe(true);
        const aiServices = options.services.slice(
            options.services.findIndex(option => option.value === 'ai') + 1,
        );
        expect(aiServices.map(option => option.value)).toEqual([
            services.deepseek,
            services.tongyi,
            services.doubao,
            services.moonshot,
            services.zhipu,
            services.huanYuan,
            services.huanYuanTranslation,
            services.yiyan,
            services.minimax,
            services.mimo,
            services.jieyue,
            services.openai,
            services.chatgptPlan,
            services.gemini,
            services.claude,
            services.grok,
            services.siliconCloud,
            services.newapi,
            services.infini,
            services.openrouter,
            services.groq,
            services.azureOpenai,
            services.mistral,
            services.cohere,
            services.cerebras,
            services.togetherai,
            services.fireworks,
            services.deepinfra,
            services.perplexity,
            services.runcrate,
            services.ollama,
            services.custom,
        ]);
        expect(aiServices.filter(option => option.catalogKind === 'platform').map(option => option.value)).toEqual([
            services.siliconCloud,
            services.newapi,
            services.infini,
            services.openrouter,
            services.groq,
            services.azureOpenai,
            services.mistral,
            services.cohere,
            services.cerebras,
            services.togetherai,
            services.fireworks,
            services.deepinfra,
            services.perplexity,
            services.runcrate,
            services.ollama,
            services.custom,
        ]);
        expect(aiServices.filter(option => option.catalogKind === 'provider')).toHaveLength(16);
        expect(servicesType.isMachine(services.freeTranslation)).toBe(true);
        expect(defaultOption.service).toBe(services.freeTranslation);
    });

    it('退役服务回退到可用默认值并清除遗留连接配置', () => {
        const normalized = normalizeConfig({
            service: 'cozecom',
            documentService: 'cozecn',
            videoService: 'cozecom',
            translationCenterServices: ['google', 'cozecom', 'cozecn'],
            token: {openai: 'keep-token', cozecom: 'retired-token'},
            model: {cozecom: 'retired-model'},
            documentModel: {cozecn: 'retired-model'},
            customModel: {cozecom: 'retired-custom-model'},
            documentCustomModel: {cozecn: 'retired-custom-model'},
            proxy: {cozecom: 'https://retired.example'},
            customBody: {cozecn: '{"retired":true}'},
            system_role: {cozecom: 'retired system'},
            user_role: {cozecn: 'retired user'},
            requireApiKey: {
                'openai:gpt-5.6-luna': false,
                'cozecom:retired-model': false,
            },
            robot_id: {cozecom: 'retired-bot'},
        });

        expect(normalized.service).toBe(services.freeTranslation);
        expect(normalized.documentService).toBe('');
        expect(normalized.videoService).toBe('');
        expect(normalized.translationCenterServices).toEqual([services.google]);
        expect(normalized.token).toMatchObject({openai: 'keep-token'});
        expect(normalized.requireApiKey).toEqual({'openai:gpt-5.6-luna': false});
        for (const mapping of [
            normalized.token,
            normalized.model,
            normalized.documentModel,
            normalized.customModel,
            normalized.documentCustomModel,
            normalized.proxy,
            normalized.customBody,
            normalized.system_role,
            normalized.user_role,
        ]) {
            expect(mapping).not.toHaveProperty('cozecom');
            expect(mapping).not.toHaveProperty('cozecn');
        }
        expect((normalized as unknown as Record<string, unknown>).robot_id).toBeUndefined();
    });

    it('默认翻译提示词要求完整翻译，不再允许整段返回原文（Issue #54）', () => {
        expect(defaultOption.user_role).not.toContain('If translation is unnecessary');
        expect(defaultOption.user_role).toContain('no part of the source text may stay in its original language');
        expect(defaultOption.user_role).toContain('{{to}}');
        expect(defaultOption.user_role).toContain('{{origin}}');
        expect(LEGACY_DEFAULT_USER_ROLES).not.toContain(defaultOption.user_role);
    });

    it('仍停留在历史默认提示词的配置升级为当前默认值，自定义提示词原样保留', () => {
        const custom = 'Translate {{origin}} into {{to}} with my own rules.';
        const normalized = normalizeConfig({
            user_role: {
                [services.openai]: LEGACY_DEFAULT_USER_ROLES[0]!,
                [services.deepseek]: custom,
            },
        });

        expect(normalized.user_role[services.openai]).toBe(defaultOption.user_role);
        expect(normalized.user_role[services.deepseek]).toBe(custom);
        // 未显式保存过提示词的服务同样落在当前默认值上。
        expect(normalized.user_role[services.microsoft]).toBe(defaultOption.user_role);
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('所有需要模型的 AI 服务默认使用推荐模型档位', () => {
        for (const [service, defaultModel] of Object.entries(defaultModelIds)) {
            expect(defaultModels.get(service), `${service} 默认模型`).toBe(defaultModel);
            expect(models.get(service)?.at(0), `${service} 模型列表首项`).toBe(defaultModel);
        }
    });

    it('刷新后的网页和文档默认使用轻量模型，目录没有重复编号', () => {
        const expected = {
            [services.openai]: 'gpt-5.4-mini',
            [services.azureOpenai]: 'gpt-5.4-mini',
            [services.gemini]: 'gemini-3.5-flash-lite',
            [services.deepseek]: 'deepseek-flash',
            [services.infini]: 'deepseek-v4-flash',
            [services.tongyi]: 'qwen3.8-flash',
            [services.claude]: 'claude-haiku-4-5',
            [services.jieyue]: 'step-2-mini',
            [services.openrouter]: 'google/gemini-3.5-flash-lite',
        };
        for (const config of [new Config(), normalizeConfig({}), normalizeConfig({model: {}, documentModel: {}})]) {
            expect(config.model).toMatchObject(expected);
            expect(config.documentModel).toMatchObject(expected);
            expect(config.deepseekThinkingMode).toBe('disabled');
        }
        for (const [service, choices] of models) {
            expect(new Set(choices).size, service).toBe(choices.length);
        }
        expect(models.get(services.infini)).not.toContain('deepseek-flash');
        expect(models.get(services.openrouter)).toContain('deepseek/deepseek-v4.1-flash');
        expect(models.get(services.openrouter)).not.toContain('deepseek-flash');
    });

    it('已下线的混元预览版迁移到正式版，保留网页和文档的思考偏好', () => {
        const normalized = normalizeConfig({
            model: {[services.huanYuan]: 'hy3-preview'},
            documentModel: {[services.huanYuan]: 'hy3-preview'},
            modelThinking: {[services.huanYuan]: {'hy3-preview': false}},
        });
        expect(normalized.model[services.huanYuan]).toBe('hy3');
        expect(normalized.documentModel[services.huanYuan]).toBe('hy3');
        expect(normalized.modelThinking[services.huanYuan]).toEqual({hy3: false});
        expect(models.get(services.huanYuan)).not.toContain('hy3-preview');
    });

    it('刷新默认不覆盖已选模型、DeepSeek 兼容别名、密钥要求及自定义模型', () => {
        const saved = {
            ...new Config(),
            model: {
                [services.openai]: 'gpt-5.6-luna',
                [services.gemini]: 'gemini-3.6-flash',
                [services.tongyi]: 'qwen3.6-flash',
                [services.deepseek]: 'deepseek-v4-flash',
            },
            documentModel: {
                [services.deepseek]: 'deepseek-v4-pro',
                [services.openai]: customModelString,
            },
            documentCustomModel: {[services.openai]: 'private-document-model'},
            customModels: {[services.openai]: ['private-document-model']},
            modelThinking: {[services.deepseek]: {'deepseek-v4-flash': true, 'deepseek-v4-pro': false}},
            requireApiKey: {'deepseek:deepseek-v4-flash': false},
        };
        const normalized = normalizeConfig(saved);
        expect(normalized.model).toMatchObject(saved.model);
        expect(normalized.documentModel).toMatchObject(saved.documentModel);
        expect(normalized.documentCustomModel).toEqual(saved.documentCustomModel);
        expect(normalized.customModels).toEqual(saved.customModels);
        expect(normalized.modelThinking).toEqual(saved.modelThinking);
        expect(normalized.requireApiKey).toEqual(saved.requireApiKey);
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('把旧自定义接口迁移为 profile，并保留地址、实际模型和其他按服务配置', () => {
        const normalized = normalizeConfig({
            service: services.custom,
            custom: 'http://127.0.0.1:11434/v1/chat/completions',
            model: {[services.custom]: customModelString},
            customModel: {[services.custom]: 'local/translation-model'},
            token: {[services.custom]: 'local-token'},
            proxy: {[services.custom]: 'http://127.0.0.1:8080'},
            system_role: {[services.custom]: 'Translate safely.'},
            user_role: {[services.custom]: 'Translate {{origin}} into {{to}}.'},
            customBody: {[services.custom]: '{"stream":false}'},
        });

        expect(normalized).toMatchObject({
            service: services.custom,
            custom: 'http://127.0.0.1:11434/v1/chat/completions',
            model: {[services.custom]: 'local/translation-model'},
            customModel: {},
            customOpenAIProviders: [{
                id: services.custom,
                name: '自定义接口',
                endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
                models: ['local/translation-model'],
            }],
            token: {[services.custom]: 'local-token'},
            proxy: {[services.custom]: 'http://127.0.0.1:8080'},
            system_role: {[services.custom]: 'Translate safely.'},
            user_role: {[services.custom]: 'Translate {{origin}} into {{to}}.'},
            customBody: {[services.custom]: '{"stream":false}'},
        });
    });

    it('旧 custom 当前选择预设模型时仍保留页面与文档曾保存的自定义模型', () => {
        const normalized = normalizeConfig({
            service: services.custom,
            documentService: services.custom,
            model: {[services.custom]: 'page-preset-model'},
            documentModel: {[services.custom]: 'document-preset-model'},
            customModel: {[services.custom]: 'saved-page-custom-model'},
            documentCustomModel: {[services.custom]: 'saved-document-custom-model'},
        });

        expect(normalized.model[services.custom]).toBe('page-preset-model');
        expect(normalized.documentModel[services.custom]).toBe('document-preset-model');
        expect(normalized.customModel).not.toHaveProperty(services.custom);
        expect(normalized.documentCustomModel).not.toHaveProperty(services.custom);
        expect(normalized.customOpenAIProviders).toEqual([{
            id: services.custom,
            name: '自定义接口',
            endpoint: defaultOption.custom,
            models: [
                'page-preset-model',
                'document-preset-model',
                'saved-page-custom-model',
                'saved-document-custom-model',
            ],
        }]);
    });

    it('从每一种未引用的 legacy 自定义字段发现并迁移旧服务', () => {
        const defaultCustomModel = defaultModels.get(services.custom)!;
        const cases = [
            {
                value: {custom: 'https://endpoint-only.example/v1/chat/completions'},
                expected: (config: Config) => config.customOpenAIProviders[0].endpoint
                    === 'https://endpoint-only.example/v1/chat/completions',
            },
            {
                value: {documentModel: {[services.custom]: 'document-only-model'}},
                expected: (config: Config) => config.customOpenAIProviders[0].models.includes('document-only-model'),
            },
            {
                value: {system_role: {[services.custom]: 'system-only-role'}},
                expected: (config: Config) => config.system_role[services.custom] === 'system-only-role',
            },
            {
                value: {user_role: {[services.custom]: 'user-only-role'}},
                expected: (config: Config) => config.user_role[services.custom] === 'user-only-role',
            },
            {
                value: {
                    model: {[services.custom]: defaultCustomModel},
                    requireApiKey: {[`${services.custom}:${defaultCustomModel}`]: false},
                },
                expected: (config: Config) => config.requireApiKey[`${services.custom}:${defaultCustomModel}`] === false
                    && config.requireApiKey[createApiKeyRequirementKey(services.custom, defaultCustomModel)] === false,
            },
            {
                value: {
                    model: {[services.custom]: defaultCustomModel},
                    requireApiKey: {[createApiKeyRequirementKey(services.custom, defaultCustomModel)]: false},
                },
                expected: (config: Config) => config.requireApiKey[
                    createApiKeyRequirementKey(services.custom, defaultCustomModel)
                ] === false,
            },
        ];

        for (const item of cases) {
            const normalized = normalizeConfig(item.value);
            expect(normalized.customOpenAIProviders).toHaveLength(1);
            expect(item.expected(normalized)).toBe(true);
        }
        expect(normalizeConfig({custom: defaultOption.custom}).customOpenAIProviders).toEqual([]);
        // 仅停留在历史默认提示词不算用户改写，升级默认提示词不得凭空重建 legacy profile。
        expect(normalizeConfig({
            user_role: {[services.custom]: LEGACY_DEFAULT_USER_ROLES[0]!},
        }).customOpenAIProviders).toEqual([]);
    });

    it('回填空 legacy profile 地址，并容忍没有任何模型的动态 profile', () => {
        const normalizedLegacy = normalizeConfig({
            custom: 'https://legacy-fill.example/v1/chat/completions',
            customOpenAIProviders: [{
                id: services.custom,
                name: '旧接口',
                endpoint: '',
                models: ['legacy-profile-model'],
            }, {
                id: 'custom:other',
                name: '其他接口',
                endpoint: 'https://other.example/v1/chat/completions',
                models: ['other-model'],
            }],
        });
        expect(normalizedLegacy.customOpenAIProviders[0]).toMatchObject({
            endpoint: 'https://legacy-fill.example/v1/chat/completions',
            models: ['legacy-profile-model'],
        });
        expect(normalizedLegacy.customOpenAIProviders[1]).toMatchObject({
            endpoint: 'https://other.example/v1/chat/completions',
            models: ['other-model'],
        });
        expect(normalizedLegacy.model[services.custom]).toBe('legacy-profile-model');

        const emptyService = 'custom:empty';
        const normalizedEmpty = normalizeConfig({
            service: emptyService,
            documentService: emptyService,
            customOpenAIProviders: [{
                id: emptyService,
                name: '空模型服务',
                endpoint: 'https://empty.example/v1/chat/completions',
                models: [],
            }],
        });
        expect(normalizedEmpty.customOpenAIProviders[0].models).toEqual([]);
        expect(normalizedEmpty.model).not.toHaveProperty(emptyService);
        expect(normalizedEmpty.documentModel).not.toHaveProperty(emptyService);
        expect(normalizeConfig({...new Config(), service: null}).service).toBe(defaultOption.service);
    });

    it('动态 profile 拒绝界面保留的模型哨兵并回退到真实已保存模型', () => {
        const service = 'custom:reserved';
        const normalized = normalizeConfig({
            service,
            documentService: service,
            customOpenAIProviders: [{
                id: service,
                name: '保留名测试',
                endpoint: 'https://reserved.example/v1/chat/completions',
                models: [CUSTOM_OPENAI_RESERVED_MODEL_ID, 'real-model'],
            }],
            model: {[service]: CUSTOM_OPENAI_RESERVED_MODEL_ID},
            documentModel: {[service]: CUSTOM_OPENAI_RESERVED_MODEL_ID},
        });

        expect(normalized.customOpenAIProviders[0].models).toEqual(['real-model']);
        expect(normalized.model[service]).toBe('real-model');
        expect(normalized.documentModel[service]).toBe('real-model');
    });

    it('模型列表满额时同时保护页面与文档的活跃模型且不突破容量上限', () => {
        const service = 'custom:full';
        const storedModels = Array.from(
            {length: MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER},
            (_, index) => `stored-model-${index + 1}`,
        );
        const normalized = normalizeConfig({
            service,
            documentService: service,
            customOpenAIProviders: [{
                id: service,
                name: '满额服务',
                endpoint: 'https://full.example/v1/chat/completions',
                models: storedModels,
            }],
            model: {[service]: 'active-page-model'},
            documentModel: {[service]: 'active-document-model'},
        });

        const models = normalized.customOpenAIProviders[0].models;
        expect(models).toHaveLength(MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
        expect(models).toContain('active-page-model');
        expect(models).toContain('active-document-model');
        expect(new Set(models)).toHaveLength(MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
    });

    it('满额腾位时不会删除已保存且仍需保护的旧自定义模型', () => {
        const service = 'custom:protected';
        const storedModels = Array.from(
            {length: MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER},
            (_, index) => `stored-model-${index + 1}`,
        );
        const protectedStoredModel = storedModels.at(-1)!;
        const normalized = normalizeConfig({
            customOpenAIProviders: [{
                id: service,
                name: '保护模型服务',
                endpoint: 'https://protected.example/v1/chat/completions',
                models: storedModels,
            }],
            model: {[service]: 'active-page-model'},
            documentModel: {[service]: 'active-document-model'},
            customModel: {[service]: protectedStoredModel},
        });

        expect(normalized.customOpenAIProviders[0].models).toHaveLength(MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
        expect(normalized.customOpenAIProviders[0].models).toEqual(expect.arrayContaining([
            protectedStoredModel,
            'active-page-model',
            'active-document-model',
        ]));
    });

    it('不会把下拉列表中仍可选择的模型当成退役编号改写', () => {
        for (const [service, selectableModels] of models) {
            for (const selectedModel of selectableModels) {
                if (service === services.custom && selectedModel === customModelString) continue;
                const normalized = normalizeConfig(service === services.custom
                    ? {service, model: {[service]: selectedModel}}
                    : {model: {[service]: selectedModel}});
                expect(normalized.model[service], `${service}: ${selectedModel}`).toBe(selectedModel);
            }
        }
    });

    it('显式新 schema 删除 legacy profile 后不会被 deprecated scalar 重建', () => {
        const normalized = normalizeConfig({
            ...new Config(),
            service: services.custom,
            custom: 'https://legacy.example/v1/chat/completions',
            customOpenAIProviders: [],
            model: {[services.custom]: 'legacy-model'},
            token: {[services.custom]: 'legacy-token'},
            proxy: {[services.custom]: 'https://proxy.example'},
            customBody: {[services.custom]: '{"legacy":true}'},
            system_role: {[services.custom]: 'legacy system'},
            user_role: {[services.custom]: 'legacy user'},
            requireApiKey: {'custom:legacy-model': false},
        });

        expect(normalized.service).toBe(defaultOption.service);
        expect(normalized.customOpenAIProviders).toEqual([]);
        for (const mapping of [
            normalized.model,
            normalized.token,
            normalized.proxy,
            normalized.customBody,
            normalized.system_role,
            normalized.user_role,
        ]) expect(mapping).not.toHaveProperty(services.custom);
        expect(normalized.requireApiKey).not.toHaveProperty('custom:legacy-model');
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('仅凭旧 token.custom 也创建 legacy profile，迁移后重复归一化完全幂等', () => {
        const normalized = normalizeConfig({
            token: {[services.custom]: 'legacy-token'},
        });

        expect(normalized.customOpenAIProviders).toEqual([{
            id: services.custom,
            name: '自定义接口',
            endpoint: defaultOption.custom,
            models: [defaultModels.get(services.custom)],
        }]);
        expect(normalized.token[services.custom]).toBe('legacy-token');
        expect(normalized.model[services.custom]).toBe(defaultModels.get(services.custom));
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('动态 profile 可用于全部服务引用，且任意数量的服务都会保留并清理不可达项', () => {
        const providerCount = 24;
        const providers = Array.from({length: providerCount}, (_, index) => ({
            id: `custom:${index + 1}`,
            name: `服务 ${index + 1}`,
            endpoint: `https://provider-${index + 1}.example/v1/chat/completions`,
            models: [`model-${index + 1}`],
        }));
        const normalized = normalizeConfig({
            customOpenAIProviders: providers,
            service: 'custom:1',
            documentService: 'custom:2',
            videoService: 'custom:3',
            translationCenterServices: ['custom:1', 'custom:20', 'custom:21', 'custom:999'],
            model: {'custom:1': 'model-1', 'custom:21': 'model-21'},
            token: {'custom:1': 'keep', 'custom:999': 'drop'},
            apiKeyRotationEnabled: {'custom:1': false, 'custom:999': true},
            proxy: {'custom:999': 'https://drop.example'},
            requireApiKey: {
                'custom:legacy-model': false,
                'custom:1:model-1': false,
                'custom:999:model-999': false,
                [createApiKeyRequirementKey('custom:1', 'model-1')]: true,
                [createApiKeyRequirementKey('custom:999', 'model-999')]: false,
                [createApiKeyRequirementKey('openai', 'static-model')]: false,
                'v2:{bad-json': false,
            },
        });

        expect(normalized.customOpenAIProviders).toHaveLength(providerCount);
        expect(normalized).toMatchObject({
            service: 'custom:1',
            documentService: 'custom:2',
            videoService: 'custom:3',
            translationCenterServices: ['custom:1', 'custom:20', 'custom:21'],
        });
        expect(normalized.token).toMatchObject({'custom:1': 'keep'});
        expect(normalized.token).not.toHaveProperty('custom:999');
        expect(normalized.apiKeyRotationEnabled).toEqual({'custom:1': false});
        expect(normalized.model).not.toHaveProperty('custom:999');
        expect(normalized.proxy).not.toHaveProperty('custom:999');
        expect(normalized.requireApiKey).toEqual({
            'custom:1:model-1': false,
            [createApiKeyRequirementKey('custom:1', 'model-1')]: true,
            [createApiKeyRequirementKey('openai', 'static-model')]: false,
        });
    });
});

describe('图片翻译配置', () => {
    it('默认关闭，并保留用户主动启用或关闭的状态', () => {
        expect(new Config().disableImageTranslator).toBe(true);
        expect(normalizeConfig({}).disableImageTranslator).toBe(true);
        expect(normalizeConfig({disableImageTranslator: false}).disableImageTranslator).toBe(false);
        expect(normalizeConfig({disableImageTranslator: true}).disableImageTranslator).toBe(true);
    });
});

describe('翻译中心配置', () => {
    it('结果布局默认列表，保留并排选择且安全归一化旧配置', () => {
        expect(new Config().translationCenterLayout).toBe('list');
        expect(normalizeConfig({}).translationCenterLayout).toBe('list');
        expect(normalizeConfig({translationCenterLayout: 'grid'}).translationCenterLayout).toBe('grid');
        expect(normalizeConfig({translationCenterLayout: 'invalid'}).translationCenterLayout).toBe('list');
    });
    it('默认使用服务列表，保存后保留去重后的服务顺序和语言选择', () => {
        expect(new Config().translationCenterServices).toEqual([]);
        expect(normalizeConfig({
            translationCenterServices: ['google', 'openai', 'google', ' ', 12],
            translationCenterSourceLanguage: ' en ',
            translationCenterTargetLanguage: ' ja ',
        })).toMatchObject({
            translationCenterServices: ['google', 'openai'],
            translationCenterSourceLanguage: 'en',
            translationCenterTargetLanguage: 'ja',
        });
    });

    it('旧配置或非法值安全回退为空服务配置', () => {
        expect(normalizeConfig({
            translationCenterServices: 'google',
            translationCenterSourceLanguage: 12,
            translationCenterTargetLanguage: null,
        })).toMatchObject({
            translationCenterServices: [],
            translationCenterSourceLanguage: '',
            translationCenterTargetLanguage: '',
        });
    });
});

describe('快捷翻译方案配置', () => {
    it('默认为空列表，并保留 Ctrl+T/Ctrl+Y 的独立动作与展示设置', () => {
        expect(new Config().quickTranslationProfiles).toEqual([]);
        expect(normalizeConfig({}).quickTranslationProfiles).toEqual([]);

        const normalized = normalizeConfig({
            quickTranslationProfiles: [
                {
                    id: ' hover / primary ',
                    enabled: true,
                    action: 'hover',
                    hotkey: ' control + t ',
                    service: services.openai,
                    model: '  quick-gpt  ',
                    targetLanguage: ' ja ',
                    displayMode: 'bilingual',
                    fullPageMode: 'all',
                },
                {
                    id: 'page',
                    enabled: false,
                    action: 'full-page',
                    hotkey: 'CTRL+y',
                    service: services.microsoft,
                    model: 'machine-services-do-not-use-models',
                    targetLanguage: ' en ',
                    displayMode: 'translation-only',
                    fullPageMode: 'all',
                },
            ],
        });

        expect(normalized.quickTranslationProfiles).toEqual([
            {
                id: 'hover-primary',
                enabled: true,
                action: 'hover',
                hotkey: 'Ctrl+T',
                service: services.openai,
                model: 'quick-gpt',
                targetLanguage: 'ja',
                displayMode: 'bilingual',
                fullPageMode: 'inherit',
            },
            {
                id: 'page',
                enabled: false,
                action: 'full-page',
                hotkey: 'Ctrl+Y',
                service: services.microsoft,
                model: '',
                targetLanguage: 'en',
                displayMode: 'translation-only',
                fullPageMode: 'all',
            },
        ]);
    });

    it('清理畸形/重复热键与未知服务，并只为支持模型的服务保留有界模型名', () => {
        const longModel = 'm'.repeat(MAX_QUICK_TRANSLATION_MODEL_LENGTH + 20);
        const normalized = normalizeConfig({
            customOpenAIProviders: [{
                id: 'custom:team',
                name: '团队网关',
                endpoint: 'https://team.example/v1/chat/completions',
                models: ['team-default'],
            }],
            quickTranslationProfiles: [
                {
                    id: 'first', action: 'hover', hotkey: 'Ctrl+T',
                    service: services.openai, model: longModel,
                },
                {
                    id: 'duplicate', action: 'full-page', hotkey: 'control+t',
                    service: services.microsoft, model: 'must-clear',
                    displayMode: 'invalid', fullPageMode: 'viewport',
                },
                {
                    id: 'custom', action: 'hover', hotkey: 'Option+Y',
                    service: 'custom:team', model: '  vendor-model  ',
                },
                {
                    id: 'unknown', action: 'hover', hotkey: 'Ctrl+Hyper+Y',
                    service: 'removed-service', model: 'must-clear',
                },
            ],
        });

        expect(normalized.quickTranslationProfiles[0].model).toBe(
            'm'.repeat(MAX_QUICK_TRANSLATION_MODEL_LENGTH),
        );
        expect(normalized.quickTranslationProfiles[1]).toMatchObject({
            hotkey: '',
            service: services.microsoft,
            model: '',
            displayMode: 'inherit',
            fullPageMode: 'viewport',
        });
        expect(normalized.quickTranslationProfiles[2]).toMatchObject({
            hotkey: 'Alt+Y',
            service: 'custom:team',
            model: 'vendor-model',
            fullPageMode: 'inherit',
        });
        expect(normalized.quickTranslationProfiles[3]).toMatchObject({
            hotkey: '',
            service: '',
            model: '',
            enabled: false,
        });
    });

    it('孤儿服务与旧快捷键冲突会安全停用，Google 切换后仍保留显示偏好', () => {
        const normalized = normalizeConfig({
            floatingBallHotkey: 'Alt+T',
            quickTranslationProfiles: [
                {id: 'orphan', enabled: true, action: 'hover', hotkey: 'Ctrl+Y',
                    service: 'custom:removed', model: 'private-model'},
                {id: 'conflict', enabled: true, action: 'hover', hotkey: 'Alt+T',
                    service: services.openai, model: 'gpt-4o-mini'},
                {id: 'google', enabled: true, action: 'full-page', hotkey: 'Ctrl+U',
                    service: services.google, displayMode: 'translation-only'},
            ],
        }).quickTranslationProfiles;

        expect(normalized[0]).toMatchObject({
            enabled: false, hotkey: 'Ctrl+Y', service: '', model: '',
        });
        expect(normalized[1]).toMatchObject({enabled: false, hotkey: 'Alt+T'});
        expect(normalized[2]).toMatchObject({enabled: true, displayMode: 'translation-only'});
    });

    it.each([
        ['ctrl_enter', 'Ctrl+Enter'],
        ['triple_space', 'Space'],
        ['triple_equal', '='],
        ['triple_dash', '-'],
    ])('输入框触发 %s 启用时保留既有功能的 %s 所有权', (trigger, hotkey) => {
        const [normalized] = normalizeConfig({
            inputBoxTranslationTrigger: trigger,
            quickTranslationProfiles: [{
                id: 'input-conflict', enabled: true, action: 'hover', hotkey,
                service: services.openai, model: 'gpt-4o-mini',
            }],
        }).quickTranslationProfiles;

        expect(normalized).toMatchObject({hotkey, enabled: false});
    });

    it('圈选改用自定义快捷键后，快捷翻译方案按新的圈选快捷键避让', () => {
        const config = normalizeConfig({
            selectionAreaEnabled: true,
            selectionAreaHotkey: 'custom',
            customSelectionAreaHotkey: 'alt+k',
            quickTranslationProfiles: [
                {id: 'old-area', enabled: true, action: 'hover', hotkey: 'Shift+Z'},
                {id: 'new-area', enabled: true, action: 'full-page', hotkey: 'Alt+K'},
            ],
        });

        expect(config).toMatchObject({selectionAreaHotkey: 'custom', customSelectionAreaHotkey: 'Alt+K'});
        expect(config.quickTranslationProfiles[0]).toMatchObject({hotkey: 'Shift+Z', enabled: true});
        expect(config.quickTranslationProfiles[1]).toMatchObject({hotkey: 'Alt+K', enabled: false});
    });

    it('圈选快捷键只接受预设与可用的自定义值，其余配置回到默认 Shift+Z', () => {
        expect(new Config()).toMatchObject({selectionAreaHotkey: 'Shift+Z', customSelectionAreaHotkey: ''});
        expect(normalizeConfig({})).toMatchObject({selectionAreaHotkey: 'Shift+Z', customSelectionAreaHotkey: ''});
        expect(normalizeConfig({selectionAreaHotkey: 'alt+x'})).toMatchObject({selectionAreaHotkey: 'Alt+X'});
        // 选择自定义却没有可用组合键时不能让圈选失去唯一入口。
        expect(normalizeConfig({selectionAreaHotkey: 'custom', customSelectionAreaHotkey: 'cmd+k'}))
            .toMatchObject({selectionAreaHotkey: 'Shift+Z', customSelectionAreaHotkey: ''});
        for (const invalid of [undefined, 'none', 'Ctrl+C', 42]) {
            expect(normalizeConfig({selectionAreaHotkey: invalid}).selectionAreaHotkey).toBe('Shift+Z');
        }
    });

    it('段落复制快捷键只接受预设与可用的自定义值，其余配置回到默认 Alt+C', () => {
        expect(new Config()).toMatchObject({
            paragraphCopyEnabled: false, paragraphCopyHotkey: 'Alt+C', customParagraphCopyHotkey: '', paragraphCopyContent: 'auto',
        });
        expect(normalizeConfig({})).toMatchObject({paragraphCopyHotkey: 'Alt+C', customParagraphCopyHotkey: '', paragraphCopyContent: 'auto'});
        expect(normalizeConfig({paragraphCopyHotkey: 'shift+d'})).toMatchObject({paragraphCopyHotkey: 'Shift+D'});
        expect(normalizeConfig({paragraphCopyContent: 'bilingual'})).toMatchObject({paragraphCopyContent: 'bilingual'});
        expect(normalizeConfig({paragraphCopyContent: 'both'})).toMatchObject({paragraphCopyContent: 'auto'});
        // 选择自定义却没有可用组合键时不能让段落复制失去唯一入口。
        expect(normalizeConfig({paragraphCopyHotkey: 'custom', customParagraphCopyHotkey: 'cmd+k'}))
            .toMatchObject({paragraphCopyHotkey: 'Alt+C', customParagraphCopyHotkey: ''});
        expect(normalizeConfig({paragraphCopyEnabled: 'yes'})).toMatchObject({paragraphCopyEnabled: false});
        expect(normalizeConfig({paragraphCopyEnabled: false})).toMatchObject({paragraphCopyEnabled: false});
    });

    it('快捷翻译方案按段落复制的实际快捷键避让，关闭后释放占用', () => {
        const occupied = normalizeConfig({
            paragraphCopyEnabled: true,
            paragraphCopyHotkey: 'custom',
            customParagraphCopyHotkey: 'alt+j',
            quickTranslationProfiles: [{id: 'copy-clash', enabled: true, action: 'hover', hotkey: 'Alt+J'}],
        });
        expect(occupied.quickTranslationProfiles[0]).toMatchObject({hotkey: 'Alt+J', enabled: false});

        const released = normalizeConfig({
            paragraphCopyEnabled: false,
            paragraphCopyHotkey: 'custom',
            customParagraphCopyHotkey: 'alt+j',
            quickTranslationProfiles: [{id: 'copy-clash', enabled: true, action: 'hover', hotkey: 'Alt+J'}],
        });
        expect(released.quickTranslationProfiles[0]).toMatchObject({hotkey: 'Alt+J', enabled: true});
    });

    it('局部翻译快捷键默认关闭，只接受预设与可用的自定义值', () => {
        expect(new Config()).toMatchObject({
            sectionTranslationHotkeyEnabled: false, sectionTranslationHotkey: 'Alt+R', customSectionTranslationHotkey: '',
        });
        expect(normalizeConfig({})).toMatchObject({
            sectionTranslationHotkeyEnabled: false, sectionTranslationHotkey: 'Alt+R', customSectionTranslationHotkey: '',
        });
        expect(normalizeConfig({sectionTranslationHotkeyEnabled: true, sectionTranslationHotkey: 'shift+x'}))
            .toMatchObject({sectionTranslationHotkeyEnabled: true, sectionTranslationHotkey: 'Shift+X'});
        expect(normalizeConfig({sectionTranslationHotkeyEnabled: 'yes'})).toMatchObject({sectionTranslationHotkeyEnabled: false});
        expect(normalizeConfig({sectionTranslationHotkey: 'custom', customSectionTranslationHotkey: 'alt+k'}))
            .toMatchObject({sectionTranslationHotkey: 'custom', customSectionTranslationHotkey: 'Alt+K'});
        // 选择自定义却没有可用组合键时回到默认预设，开启的快捷键不会失去可用组合。
        expect(normalizeConfig({sectionTranslationHotkey: 'custom', customSectionTranslationHotkey: 'cmd+k'}))
            .toMatchObject({sectionTranslationHotkey: 'Alt+R', customSectionTranslationHotkey: ''});
        for (const invalid of [undefined, 'none', 'Ctrl+C', 42]) {
            expect(normalizeConfig({sectionTranslationHotkey: invalid}).sectionTranslationHotkey).toBe('Alt+R');
        }
    });

    it('快捷翻译方案只在局部翻译快捷键开启时避让它', () => {
        const profile = {id: 'section-clash', enabled: true, action: 'hover', hotkey: 'Alt+R'};
        const occupied = normalizeConfig({sectionTranslationHotkeyEnabled: true, quickTranslationProfiles: [profile]});
        expect(occupied.quickTranslationProfiles[0]).toMatchObject({hotkey: 'Alt+R', enabled: false});
        const released = normalizeConfig({sectionTranslationHotkeyEnabled: false, quickTranslationProfiles: [profile]});
        expect(released.quickTranslationProfiles[0]).toMatchObject({hotkey: 'Alt+R', enabled: true});
    });

    it('划词快捷键与快捷翻译可共存，圈选的默认快捷键仍保留既有所有权', () => {
        const normalized = normalizeConfig({
            selectionTranslatorMode: 'bilingual',
            selectionTranslatorTrigger: 'custom',
            customSelectionTranslatorHotkey: 'Ctrl+Y',
            selectionAreaEnabled: true,
            quickTranslationProfiles: [
                {id: 'selection-fallback', enabled: true, action: 'hover', hotkey: 'Ctrl+Y'},
                {id: 'area-conflict', enabled: true, action: 'hover', hotkey: 'Shift+Z'},
            ],
        }).quickTranslationProfiles;

        expect(normalized[0]).toMatchObject({hotkey: 'Ctrl+Y', enabled: true});
        expect(normalized[1]).toMatchObject({hotkey: 'Shift+Z', enabled: false});
    });

    it('忽略畸形项，为重复 ID 生成稳定替代值，并分别限制两种动作各八条', () => {
        const candidates = [
            ...Array.from({length: MAX_QUICK_TRANSLATION_PROFILES + 2}, (_, index) => ({
                id: 'same-id',
                action: 'hover',
                hotkey: `Ctrl+${String.fromCharCode(65 + index)}`,
                service: services.openai,
                model: `hover-model-${index}`,
            })),
            ...Array.from({length: MAX_QUICK_TRANSLATION_PROFILES + 2}, (_, index) => ({
                id: 'same-id',
                action: 'full-page',
                hotkey: `Alt+${String.fromCharCode(65 + index)}`,
                service: services.openai,
                model: `page-model-${index}`,
            })),
        ];
        const normalized = normalizeConfig({
            quickTranslationProfiles: [null, 'legacy', {action: 'selection'}, ...candidates],
        }).quickTranslationProfiles;

        expect(normalized).toHaveLength(MAX_QUICK_TRANSLATION_PROFILES * 2);
        expect(normalized.filter((profile) => profile.action === 'hover'))
            .toHaveLength(MAX_QUICK_TRANSLATION_PROFILES);
        expect(normalized.filter((profile) => profile.action === 'full-page'))
            .toHaveLength(MAX_QUICK_TRANSLATION_PROFILES);
        expect(normalized.map((profile) => profile.hotkey)).toEqual([
            'Ctrl+A', 'Ctrl+B', 'Ctrl+C', 'Ctrl+D',
            'Ctrl+E', 'Ctrl+F', 'Ctrl+G', 'Ctrl+H',
            'Alt+A', 'Alt+B', 'Alt+C', 'Alt+D',
            'Alt+E', 'Alt+F', 'Alt+G', 'Alt+H',
        ]);
        expect(new Set(normalized.map((profile) => profile.id)).size)
            .toBe(MAX_QUICK_TRANSLATION_PROFILES * 2);
        expect(normalizeConfig({quickTranslationProfiles: {}}).quickTranslationProfiles).toEqual([]);
    });
});

describe('圈选翻译配置', () => {
    it('默认开启，并保留用户主动启用或关闭的状态', () => {
        expect(new Config().selectionAreaEnabled).toBe(true);
        expect(normalizeConfig({}).selectionAreaEnabled).toBe(true);
        expect(normalizeConfig({selectionAreaEnabled: true}).selectionAreaEnabled).toBe(true);
        expect(normalizeConfig({selectionAreaEnabled: 'true'}).selectionAreaEnabled).toBe(true);
    });
});

describe('右键全文翻译配置', () => {
    it('默认开启，并保留用户主动关闭的状态', () => {
        expect(new Config().contextMenuEnabled).toBe(true);
        expect(normalizeConfig({}).contextMenuEnabled).toBe(true);
        expect(normalizeConfig({contextMenuEnabled: false}).contextMenuEnabled).toBe(false);
        expect(normalizeConfig({contextMenuEnabled: 'false'}).contextMenuEnabled).toBe(true);
    });
});

describe('页面标题翻译配置', () => {
    it('默认开启，并保留用户主动关闭的状态', () => {
        expect(new Config().pageTitleTranslationEnabled).toBe(true);
        expect(normalizeConfig({}).pageTitleTranslationEnabled).toBe(true);
        expect(normalizeConfig({pageTitleTranslationEnabled: false}).pageTitleTranslationEnabled).toBe(false);
        // 非布尔值（旧配置或被改坏的导入）回到默认开启，而不是被当成关闭。
        expect(normalizeConfig({pageTitleTranslationEnabled: 'false'}).pageTitleTranslationEnabled).toBe(true);
    });
});

describe('全文翻译范围配置', () => {
    it('默认关闭免滚动预翻译，并保留用户已保存的字符预算', () => {
        expect(new Config().eagerTranslationCharacters).toBe(0);
        expect(normalizeConfig({}).eagerTranslationCharacters).toBe(0);
        expect(normalizeConfig({eagerTranslationCharacters: 'invalid'}).eagerTranslationCharacters).toBe(0);
        expect(normalizeConfig({eagerTranslationCharacters: 4999}).eagerTranslationCharacters).toBe(4999);
        expect(normalizeConfig({eagerTranslationCharacters: 1200}).eagerTranslationCharacters).toBe(1200);
    });

    it('默认按阅读进度翻译，并保留立即翻译整页的选择', () => {
        expect(new Config().fullPageTranslationMode).toBe('viewport');
        expect(normalizeConfig({}).fullPageTranslationMode).toBe('viewport');
        expect(normalizeConfig({fullPageTranslationMode: 'all'}).fullPageTranslationMode).toBe('all');
        expect(normalizeConfig({fullPageTranslationMode: 'invalid'}).fullPageTranslationMode).toBe('viewport');
    });
});

describe('翻译进度面板配置', () => {
    it('默认关闭，并保留用户主动启用的状态', () => {
        expect(new Config().translationProgressPanelEnabled).toBe(false);
        expect(normalizeConfig({}).translationProgressPanelEnabled).toBe(false);
        expect(normalizeConfig({translationProgressPanelEnabled: true}).translationProgressPanelEnabled).toBe(true);
        expect(normalizeConfig({translationProgressPanelEnabled: false}).translationProgressPanelEnabled).toBe(false);
        expect(normalizeConfig({translationProgressPanelEnabled: 'false'}).translationProgressPanelEnabled).toBe(false);
    });

    it('迁移旧 translationStatus 布尔值并移除旧字段', () => {
        const enabled = normalizeConfig({translationStatus: true});
        const disabled = normalizeConfig({translationStatus: false});

        expect(enabled.translationProgressPanelEnabled).toBe(true);
        expect(disabled.translationProgressPanelEnabled).toBe(false);
        expect((enabled as unknown as Record<string, unknown>).translationStatus).toBeUndefined();
        expect((disabled as unknown as Record<string, unknown>).translationStatus).toBeUndefined();
    });
});

describe('段落翻译加载样式配置', () => {
    it('默认使用柔和圆环，并保留所有已注册选择', () => {
        expect(new Config().translationLoadingStyle).toBe('ring');
        expect(normalizeConfig({}).translationLoadingStyle).toBe('ring');
        for (const style of ['minimal', 'ring', 'dots', 'orbit', 'sparkle', 'pulse', 'wave', 'sweep', 'hourglass', 'comet', 'flip', 'bounce', 'typing', 'scan', 'signal'] as const) {
            expect(normalizeConfig({translationLoadingStyle: style}).translationLoadingStyle).toBe(style);
        }
    });

    it('未知、缺失或非字符串样式安全回到柔和圆环', () => {
        for (const value of ['classic', '', null, false, 1, {}]) {
            expect(normalizeConfig({translationLoadingStyle: value}).translationLoadingStyle).toBe('ring');
        }
    });
});

describe('双语逐句高亮配置', () => {
    it('旧配置保留开关，新样式单独保存，非法值回到柔光粉', () => {
        expect(new Config().bilingualSentenceHighlightStyle).toBe('rose');
        for (const style of ['rose', 'mint', 'sky', 'underline', 'amber', 'lavender', 'slate', 'dotted']) {
            expect(normalizeConfig({bilingualSentenceHighlightEnabled: false, bilingualSentenceHighlightStyle: style}))
                .toMatchObject({bilingualSentenceHighlightEnabled: false, bilingualSentenceHighlightStyle: style});
        }
        for (const style of [undefined, null, false, {}, 'unknown']) {
            expect(normalizeConfig({bilingualSentenceHighlightEnabled: true, bilingualSentenceHighlightStyle: style}))
                .toMatchObject({bilingualSentenceHighlightEnabled: true, bilingualSentenceHighlightStyle: 'rose'});
        }
    });
    it('默认关闭，并只接受显式布尔值开启', () => {
        expect(new Config().bilingualSentenceHighlightEnabled).toBe(false);
        expect(normalizeConfig({}).bilingualSentenceHighlightEnabled).toBe(false);
        expect(normalizeConfig({bilingualSentenceHighlightEnabled: true}).bilingualSentenceHighlightEnabled).toBe(true);
        expect(normalizeConfig({bilingualSentenceHighlightEnabled: false}).bilingualSentenceHighlightEnabled).toBe(false);
        expect(normalizeConfig({bilingualSentenceHighlightEnabled: 'true'}).bilingualSentenceHighlightEnabled).toBe(false);
    });
});

describe('译文外观配置', () => {
    it('默认沿用样式自带外观，并归一化导入或存储中的外观微调', () => {
        const defaults = {textColor: '', backgroundColor: '', lineColor: '', fillColor: '', fontScale: 100, fontWeight: 'default', fontFamily: 'default', opacity: 100, customCss: ''};
        expect(new Config().translationAppearance).toEqual(defaults);
        expect(normalizeConfig({}).translationAppearance).toEqual(defaults);
        expect(normalizeConfig({translationAppearance: 'broken'}).translationAppearance).toEqual(defaults);
        expect(normalizeConfig({translationAppearance: {textColor: '#1D4ED8', lineColor: '#ef4776', fontScale: 118, opacity: 3, fontWeight: 'bold', fontFamily: 'nope'}}).translationAppearance)
            .toEqual({...defaults, textColor: '#1d4ed8', lineColor: '#ef4776', fontScale: 118, opacity: 40, fontWeight: 'bold'});
        // 预设编号保持原样，新增编号可直接持久化。
        expect(normalizeConfig({style: 28}).style).toBe(28);
    });
});

describe('鼠标悬浮翻译延迟配置', () => {
    it('默认保留现有 50ms 行为，并归一化用户设置', () => {
        expect(new Config().mouseHoverTranslationDelay).toBe(DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY);
        expect(normalizeConfig({}).mouseHoverTranslationDelay).toBe(DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY);
        expect(normalizeConfig({mouseHoverTranslationDelay: 235}).mouseHoverTranslationDelay).toBe(240);
        expect(normalizeConfig({mouseHoverTranslationDelay: '120'}).mouseHoverTranslationDelay).toBe(120);
    });

    it('将越界或非法值限制在安全范围内', () => {
        expect(normalizeConfig({mouseHoverTranslationDelay: -100}).mouseHoverTranslationDelay)
            .toBe(MOUSE_HOVER_TRANSLATION_DELAY_MIN);
        expect(normalizeConfig({mouseHoverTranslationDelay: 99999}).mouseHoverTranslationDelay)
            .toBe(MOUSE_HOVER_TRANSLATION_DELAY_MAX);
        expect(normalizeConfig({mouseHoverTranslationDelay: 'invalid'}).mouseHoverTranslationDelay)
            .toBe(DEFAULT_MOUSE_HOVER_TRANSLATION_DELAY);
    });
});

describe('悬浮球进阶外观配置', () => {
    it('默认关闭悬浮球，开启后悬停展开；点击翻译、标准尺寸与设置入口保持可用', () => {
        const defaults = new Config();
        expect(defaults.disableFloatingBall).toBe(true);
        expect(defaults.floatingBallToolsDisplay).toBe('hover');
        expect(defaults.floatingBallHoverDelay).toBe(DEFAULT_FLOATING_BALL_HOVER_DELAY);
        expect(defaults.floatingBallClickAction).toBe('translate');
        expect(defaults.floatingBallCompact).toBe(false);
        expect(defaults.floatingBallSettingsEntryVisible).toBe(true);
        expect(defaults.floatingBallCollapsedOpacity).toBe(DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY);
        expect(defaults.floatingBallDisabledDomains).toEqual([]);

        const normalized = normalizeConfig({});
        expect(normalized.disableFloatingBall).toBe(true);
        expect(normalized.floatingBallToolsDisplay).toBe('hover');
        expect(normalized.floatingBallHoverDelay).toBe(DEFAULT_FLOATING_BALL_HOVER_DELAY);
        expect(normalized.floatingBallClickAction).toBe('translate');
        expect(normalized.floatingBallCompact).toBe(false);
        expect(normalized.floatingBallSettingsEntryVisible).toBe(true);
        expect(normalized.floatingBallCollapsedOpacity).toBe(DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY);
        expect(normalized.floatingBallDisabledDomains).toEqual([]);
    });

    it('接受合法的显示方式与点击行为，并把其他值收敛为默认值', () => {
        expect(normalizeFloatingBallToolsDisplay('always')).toBe('always');
        expect(normalizeFloatingBallToolsDisplay('hidden')).toBe('hidden');
        expect(normalizeFloatingBallToolsDisplay('sidebar')).toBe('hover');
        expect(normalizeFloatingBallToolsDisplay(undefined)).toBe('hover');
        expect(normalizeFloatingBallClickAction('settings')).toBe('settings');
        expect(normalizeFloatingBallClickAction('none')).toBe('none');
        expect(normalizeFloatingBallClickAction(12)).toBe('translate');
        expect(normalizeConfig({floatingBallToolsDisplay: 'always', floatingBallClickAction: 'none'}))
            .toMatchObject({floatingBallToolsDisplay: 'always', floatingBallClickAction: 'none'});
        expect(normalizeConfig({floatingBallToolsDisplay: 'panel', floatingBallClickAction: 'panel'}))
            .toMatchObject({floatingBallToolsDisplay: 'hover', floatingBallClickAction: 'translate'});
    });

    it('兼容旧配置并保留已经保存的开关与显示方式', () => {
        expect(normalizeConfig({disableFloatingBall: false}))
            .toMatchObject({disableFloatingBall: false, floatingBallToolsDisplay: 'hover'});
        expect(normalizeConfig({disableFloatingBall: false, floatingBallToolsDisplay: 'always'}))
            .toMatchObject({disableFloatingBall: false, floatingBallToolsDisplay: 'always'});
        expect(normalizeConfig({disableFloatingBall: true, floatingBallToolsDisplay: 'hidden'}))
            .toMatchObject({disableFloatingBall: true, floatingBallToolsDisplay: 'hidden'});
    });

    it('按步长归一化展开延迟与收起不透明度，并限制越界值', () => {
        expect(normalizeFloatingBallHoverDelay(480)).toBe(500);
        expect(normalizeFloatingBallHoverDelay('250')).toBe(250);
        expect(normalizeFloatingBallHoverDelay(-100)).toBe(FLOATING_BALL_HOVER_DELAY_MIN);
        expect(normalizeFloatingBallHoverDelay(99999)).toBe(FLOATING_BALL_HOVER_DELAY_MAX);
        for (const value of [null, false, '', '   ', 'invalid', Number.NaN]) {
            expect(normalizeFloatingBallHoverDelay(value)).toBe(DEFAULT_FLOATING_BALL_HOVER_DELAY);
        }

        expect(normalizeFloatingBallCollapsedOpacity(50)).toBe(52);
        expect(normalizeFloatingBallCollapsedOpacity('100')).toBe(FLOATING_BALL_COLLAPSED_OPACITY_MAX);
        expect(normalizeFloatingBallCollapsedOpacity(0)).toBe(FLOATING_BALL_COLLAPSED_OPACITY_MIN);
        expect(normalizeFloatingBallCollapsedOpacity(400)).toBe(FLOATING_BALL_COLLAPSED_OPACITY_MAX);
        expect(normalizeFloatingBallCollapsedOpacity('very light')).toBe(DEFAULT_FLOATING_BALL_COLLAPSED_OPACITY);
        expect(normalizeConfig({floatingBallHoverDelay: 510, floatingBallCollapsedOpacity: 31}))
            .toMatchObject({floatingBallHoverDelay: 500, floatingBallCollapsedOpacity: 32});
    });

    it('布尔开关只接受真实布尔值，设置入口默认保持开启', () => {
        expect(normalizeConfig({floatingBallCompact: true}).floatingBallCompact).toBe(true);
        expect(normalizeConfig({floatingBallCompact: 'true'}).floatingBallCompact).toBe(false);
        expect(normalizeConfig({floatingBallSettingsEntryVisible: false}).floatingBallSettingsEntryVisible).toBe(false);
        expect(normalizeConfig({floatingBallSettingsEntryVisible: 'no'}).floatingBallSettingsEntryVisible).toBe(true);
    });

    it('禁用悬浮球网站统一归并为可注册域名并去重', () => {
        expect(normalizeConfig({
            floatingBallDisabledDomains: [
                'https://mail.example.com/inbox',
                'MAIL.EXAMPLE.COM',
                'not a domain',
                42,
                'news.bbc.co.uk',
            ],
        }).floatingBallDisabledDomains).toEqual(['example.com', 'bbc.co.uk']);
        expect(normalizeConfig({floatingBallDisabledDomains: 'example.com'}).floatingBallDisabledDomains).toEqual([]);
    });
});

describe('划词翻译显示延迟配置', () => {
    it('默认等待 300ms，并归一化用户设置', () => {
        expect(new Config().selectionTranslatorDelay).toBe(DEFAULT_SELECTION_TRANSLATOR_DELAY);
        expect(normalizeConfig({}).selectionTranslatorDelay).toBe(DEFAULT_SELECTION_TRANSLATOR_DELAY);
        expect(normalizeConfig({selectionTranslatorDelay: 326}).selectionTranslatorDelay).toBe(350);
        expect(normalizeConfig({selectionTranslatorDelay: '150'}).selectionTranslatorDelay).toBe(150);
    });

    it('允许显式立即显示，并限制越界或非法值', () => {
        expect(normalizeConfig({selectionTranslatorDelay: 0}).selectionTranslatorDelay)
            .toBe(SELECTION_TRANSLATOR_DELAY_MIN);
        expect(normalizeConfig({selectionTranslatorDelay: -100}).selectionTranslatorDelay)
            .toBe(SELECTION_TRANSLATOR_DELAY_MIN);
        expect(normalizeConfig({selectionTranslatorDelay: 99999}).selectionTranslatorDelay)
            .toBe(SELECTION_TRANSLATOR_DELAY_MAX);
        expect(normalizeConfig({selectionTranslatorDelay: 'invalid'}).selectionTranslatorDelay)
            .toBe(DEFAULT_SELECTION_TRANSLATOR_DELAY);
        for (const value of [null, false, '', '   ']) {
            expect(normalizeConfig({selectionTranslatorDelay: value}).selectionTranslatorDelay)
                .toBe(DEFAULT_SELECTION_TRANSLATOR_DELAY);
        }
    });
});

describe('旧模型编号兼容迁移', () => {
    it('迁移官方服务中已退役或错误的模型编号', () => {
        const normalized = normalizeConfig({
            model: {
                [services.openai]: 'gpt5',
                [services.zhipu]: 'GLM-4-Flash',
                [services.moonshot]: 'kimi-k2-0711-preview',
                [services.claude]: 'claude-sonnet-4-0',
                [services.grok]: 'grok-4-0709',
            },
        });

        expect(normalized.model).toMatchObject({
            [services.openai]: 'gpt-5.6-luna',
            [services.zhipu]: 'glm-4.5-flash',
            [services.moonshot]: 'kimi-k3',
            [services.claude]: 'claude-sonnet-5',
            [services.grok]: 'grok-4.5',
        });
    });

    it.each(['glm-4.5', 'glm-4-plus', 'glm-4', 'glm-4v'])(
        '将智谱普通旧模型 %s 直接迁移到当前默认模型',
        legacyModel => {
            const normalized = normalizeConfig({model: {[services.zhipu]: legacyModel}});
            expect(normalized.model[services.zhipu]).toBe('glm-5.3');
        },
    );

    it.each([
        'kimi-k2-0711-preview',
        'kimi-k2-turbo-preview',
        'moonshot-v1-auto',
        'moonshot-v1-8k',
        'moonshot-v1-32k',
    ])('将 Kimi 通用旧模型 %s 直接迁移到当前默认模型', legacyModel => {
        const normalized = normalizeConfig({model: {[services.moonshot]: legacyModel}});
        expect(normalized.model[services.moonshot]).toBe('kimi-k3');
    });

    it.each([
        ['claude-3-5-sonnet', 'claude-sonnet-5'],
        ['claude-3-5-sonnet-20241022', 'claude-sonnet-5'],
        ['claude-3-opus', 'claude-opus-5'],
        ['claude-3-opus-20240229', 'claude-opus-5'],
        ['claude-3-5-haiku', 'claude-haiku-4-5'],
        ['claude-3-5-haiku-20241022', 'claude-haiku-4-5'],
    ])('将 Claude 旧模型 %s 迁移到当前同系列模型', (legacyModel, currentModel) => {
        const normalized = normalizeConfig({model: {[services.claude]: legacyModel}});
        expect(normalized.model[services.claude]).toBe(currentModel);
    });

    it.each(['claude-sonnet-4-6', 'claude-opus-4-8'])(
        '保留列表中仍可主动选择的 Claude 旧模型 %s',
        supportedModel => {
            const normalized = normalizeConfig({model: {[services.claude]: supportedModel}});
            expect(normalized.model[services.claude]).toBe(supportedModel);
        },
    );

    it('将 MiMo 即将下线的网页和文档模型迁移到对应 2.6 型号，并保留模型级偏好', () => {
        const normalized = normalizeConfig({
            model: {[services.mimo]: 'mimo-v2.5'},
            documentModel: {[services.mimo]: 'mimo-v2.5-pro'},
            modelThinking: {[services.mimo]: {
                'mimo-v2.5': false,
                'mimo-v2.5-pro': true,
            }},
        });

        expect(new Config().model[services.mimo]).toBe('mimo-v2.6-flash');
        expect(new Config().documentModel[services.mimo]).toBe('mimo-v2.6-flash');
        expect(normalized.model[services.mimo]).toBe('mimo-v2.6-flash');
        expect(normalized.documentModel[services.mimo]).toBe('mimo-v2.6-pro');
        expect(normalized.modelThinking[services.mimo]).toEqual({
            'mimo-v2.6-flash': false,
            'mimo-v2.6-pro': true,
        });
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('MiMo 自定义模型名称继续使用原值', () => {
        const normalized = normalizeConfig({
            model: {[services.mimo]: customModelString},
            customModel: {[services.mimo]: 'mimo-v2.5'},
            customModels: {[services.mimo]: ['mimo-v2.5']},
            modelThinking: {[services.mimo]: {'mimo-v2.5': true}},
        });

        expect(normalized.model[services.mimo]).toBe(customModelString);
        expect(normalized.customModel[services.mimo]).toBe('mimo-v2.5');
        expect(normalized.modelThinking[services.mimo]).toEqual({'mimo-v2.5': true});
    });

    it.each([
        ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
        ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'],
        ['llama3-8b-8192', 'openai/gpt-oss-20b'],
    ])('迁移已退役的 Groq 模型 %s', (legacyModel, currentModel) => {
        const normalized = normalizeConfig({
            model: {
                [services.groq]: legacyModel,
            },
        });

        expect(normalized.model[services.groq]).toBe(currentModel);
    });

    it('迁移已切换协议或退役的国内服务模型编号', () => {
        const normalized = normalizeConfig({
            model: {
                [services.yiyan]: 'ERNIE-Bot 4.0',
                [services.minimax]: 'chatcompletion_v2',
                [services.jieyue]: 'step-1-8k',
                [services.huanYuan]: 'hunyuan-turbos-latest',
                [services.infini]: 'glm-4-9b-chat',
            },
            documentModel: {[services.minimax]: 'MiniMax-M3.1'},
            modelThinking: {[services.minimax]: {'MiniMax-M3.1': true}},
        });

        expect(normalized.model).toMatchObject({
            [services.yiyan]: 'ernie-5.1',
            [services.minimax]: 'MiniMax-M2.7',
            [services.jieyue]: 'step-3.5-flash',
            [services.huanYuan]: 'hy3',
            [services.infini]: 'glm-5.2',
        });
        expect(normalized.documentModel[services.minimax]).toBe('MiniMax-M3.1-flash');
        expect(normalized.modelThinking[services.minimax]).toEqual({'MiniMax-M3.1-flash': true});
    });

    it('把内置兼容服务的部署别名收敛为可收藏模型，同时保留动态自定义接口的直接模型', () => {
        const normalized = normalizeConfig({
            model: {
                [services.azureOpenai]: 'gpt5',
                [services.custom]: 'gpt5',
                [services.newapi]: 'gpt5',
            },
        });

        expect(normalized.model).toMatchObject({
            [services.azureOpenai]: customModelString,
            [services.custom]: 'gpt5',
            [services.newapi]: customModelString,
        });
        expect(normalized.customModel).toMatchObject({
            [services.azureOpenai]: 'gpt5',
            [services.newapi]: 'gpt5',
        });
        expect(normalized.customModels).toMatchObject({
            [services.azureOpenai]: ['gpt5'],
            [services.newapi]: ['gpt5'],
        });
    });

    it('迁移未知的 OpenAI 直连模型编号而不改变实际请求模型', () => {
        const normalized = normalizeConfig({
            model: {[services.openai]: 'gpt-private-deployment'},
        });

        expect(normalized.model[services.openai]).toBe(customModelString);
        expect(normalized.customModel[services.openai]).toBe('gpt-private-deployment');
        expect(normalized.customModels[services.openai]).toEqual(['gpt-private-deployment']);
        expect(resolveConfiguredModel(
            normalized.model[services.openai],
            normalized.customModel[services.openai],
        )).toBe('gpt-private-deployment');
    });

    it('把旧网页与文档 singular 模型迁入服务级列表并保持归一化幂等', () => {
        const normalized = normalizeConfig({
            model: {[services.grok]: defaultModels.get(services.grok)},
            documentModel: {[services.grok]: defaultModels.get(services.grok)},
            customModel: {[services.grok]: 'legacy-page-model'},
            documentCustomModel: {[services.grok]: 'legacy-document-model'},
        });

        expect(normalized.customModels[services.grok]).toEqual([
            'legacy-page-model',
            'legacy-document-model',
        ]);
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('显式新模型列表不会复活未激活 singular，但会保护真正活跃的网页与文档模型', () => {
        const preset = defaultModels.get(services.grok)!;
        const deleted = normalizeConfig({
            ...new Config(),
            model: {...new Config().model, [services.grok]: preset},
            customModel: {[services.grok]: 'deleted-stale-model'},
            customModels: {[services.grok]: ['kept-model']},
        });
        expect(deleted.customModels[services.grok]).toEqual(['kept-model']);

        const active = normalizeConfig({
            ...new Config(),
            model: {...new Config().model, [services.grok]: customModelString},
            documentModel: {...new Config().documentModel, [services.grok]: customModelString},
            customModel: {[services.grok]: 'active-page-model'},
            documentCustomModel: {[services.grok]: 'active-document-model'},
            customModels: {},
        });
        expect(active.customModels[services.grok]).toEqual([
            'active-page-model',
            'active-document-model',
        ]);
    });

    it('内置服务模型列表满额时腾位保护两个活跃模型，并清理无效、官方及动态服务条目', () => {
        const storedModels = Array.from(
            {length: MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER},
            (_, index) => `stored-grok-model-${index + 1}`,
        );
        const preset = defaultModels.get(services.grok)!;
        const normalized = normalizeConfig({
            ...new Config(),
            model: {...new Config().model, [services.grok]: customModelString},
            documentModel: {...new Config().documentModel, [services.grok]: customModelString},
            customModel: {[services.grok]: 'active-page-model'},
            documentCustomModel: {[services.grok]: 'active-document-model'},
            customModels: {
                [services.grok]: [
                    ...storedModels,
                    '  stored-grok-model-1  ',
                    CUSTOM_OPENAI_RESERVED_MODEL_ID,
                    preset,
                    'x'.repeat(257),
                ],
                [services.microsoft]: ['machine-model'],
                'custom:1': ['dynamic-duplicate'],
                futureProvider: ['unbounded-future-model'],
            },
        });

        expect(normalized.customModels[services.grok]).toHaveLength(MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
        expect(normalized.customModels[services.grok]).toEqual(expect.arrayContaining([
            'active-page-model',
            'active-document-model',
        ]));
        expect(normalized.customModels[services.grok]).not.toContain(preset);
        expect(normalized.customModels).not.toHaveProperty(services.microsoft);
        expect(normalized.customModels).not.toHaveProperty('custom:1');
        expect(normalized.customModels).not.toHaveProperty('futureProvider');
        expect(normalizeConfig(normalized)).toEqual(normalized);

        const officialBeforeFullList = normalizeConfig({
            ...new Config(),
            customModels: {[services.grok]: [preset, ...storedModels]},
        });
        expect(officialBeforeFullList.customModels[services.grok]).toEqual(storedModels);
    });

    it('保留 DeepSeek 旧编号迁移及思考模式兼容行为', () => {
        const chat = normalizeConfig({model: {[services.deepseek]: 'deepseek-chat'}});
        const reasoner = normalizeConfig({model: {[services.deepseek]: 'deepseek-reasoner'}});

        expect(chat.model[services.deepseek]).toBe('deepseek-flash');
        expect(chat.deepseekThinkingMode).toBe('disabled');
        expect(chat.modelThinking[services.deepseek]).toEqual({'deepseek-flash': false});
        expect(reasoner.model[services.deepseek]).toBe('deepseek-flash');
        expect(reasoner.deepseekThinkingMode).toBe('enabled');
        expect(reasoner.modelThinking[services.deepseek]).toEqual({'deepseek-flash': true});
    });

    it('模型 Thinking 默认关闭，并规范化迁移可达模型状态', () => {
        expect(new Config().modelThinking).toEqual({});

        const normalized = normalizeConfig({
            ...new Config(),
            customModels: {[services.openai]: ['private-model']},
            modelThinking: {
                [services.openai]: {
                    gpt5: true,
                    [currentModelIds.openai]: false,
                    'private-model': true,
                    orphan: true,
                    invalid: 'yes',
                },
                [services.microsoft]: {'machine-model': true},
                unknown: {'future-model': true},
            },
        });

        expect(normalized.modelThinking).toEqual({
            [services.openai]: {
                [currentModelIds.openai]: false,
                'private-model': true,
            },
        });
        expect(normalizeConfig(normalized)).toEqual(normalized);
    });

    it('模型 Thinking 迁移不改写同名自定义模型，并让当前编号优先于旧编号', () => {
        const customLegacyName = normalizeConfig({
            ...new Config(),
            model: {...new Config().model, [services.openai]: customModelString},
            customModel: {[services.openai]: 'gpt5'},
            customModels: {[services.openai]: ['gpt5']},
            modelThinking: {[services.openai]: {gpt5: true}},
        });
        expect(customLegacyName.modelThinking[services.openai]).toEqual({gpt5: true});

        const officialLegacyName = normalizeConfig({
            ...new Config(),
            modelThinking: {[services.openai]: {
                gpt5: true,
                [currentModelIds.openai]: false,
            }},
        });
        expect(officialLegacyName.modelThinking[services.openai])
            .toEqual({[currentModelIds.openai]: false});
    });

    it('显式模型级 DeepSeek 值覆盖旧服务级开关并迁移旧模型键', () => {
        const explicit = normalizeConfig({
            model: {[services.deepseek]: 'deepseek-v4-flash'},
            deepseekThinkingMode: 'enabled',
            modelThinking: {[services.deepseek]: {'deepseek-v4-flash': false}},
        });
        expect(explicit.modelThinking[services.deepseek]).toEqual({'deepseek-v4-flash': false});

        const legacyKey = normalizeConfig({
            modelThinking: {[services.deepseek]: {'deepseek-reasoner': true}},
        });
        expect(legacyKey.modelThinking[services.deepseek]).toEqual({'deepseek-flash': true});

        const legacyChatKey = normalizeConfig({
            modelThinking: {[services.deepseek]: {'deepseek-chat': false}},
        });
        expect(legacyChatKey.modelThinking[services.deepseek]).toEqual({'deepseek-flash': false});
    });

    it('动态自定义服务只保留 profile 中仍可达模型的 Thinking 状态', () => {
        const normalized = normalizeConfig({
            customOpenAIProviders: [{
                id: 'custom:team',
                name: '团队模型',
                endpoint: 'https://example.com/v1/chat/completions',
                models: ['model-a'],
            }],
            model: {'custom:team': 'model-a'},
            documentModel: {'custom:team': 'model-a'},
            modelThinking: {'custom:team': {'model-a': true, orphan: false}},
        });

        expect(normalized.modelThinking).toEqual({'custom:team': {'model-a': true}});
    });
});

describe('划词翻译配置兼容', () => {
    it('为旧配置补齐可发现的触发方式，并清理非法值', () => {
        expect(normalizeConfig({selectionTranslatorMode: 'bilingual'})).toMatchObject({
            selectionTranslatorMode: 'bilingual',
            selectionTranslatorTrigger: 'icon',
            disableSelectionTranslator: false,
        });

        expect(normalizeConfig({selectionTranslatorMode: 'invalid', selectionTranslatorTrigger: 'invalid'})).toMatchObject({
            selectionTranslatorMode: 'disabled',
            selectionTranslatorTrigger: 'icon',
            disableSelectionTranslator: true,
        });
    });

    it('将划词触发方式规范化为互斥触发选项，并兼容旧快捷键配置', () => {
        expect(new Config().selectionTranslatorTrigger).toBe('icon');
        expect(new Config().selectionTranslatorHotkey).toBe('none');
        expect(new Config().customSelectionTranslatorHotkey).toBe('');
        expect(normalizeConfig({selectionTranslatorTrigger: 'Control'})).toMatchObject({
            selectionTranslatorTrigger: 'Control',
            selectionTranslatorHotkey: 'Control',
        });
        expect(normalizeConfig({selectionTranslatorTrigger: 'icon', selectionTranslatorHotkey: 'Control'})).toMatchObject({
            selectionTranslatorTrigger: 'icon',
            selectionTranslatorHotkey: 'none',
        });
        expect(normalizeConfig({selectionTranslatorMode: 'bilingual', selectionTranslatorTrigger: 'contextMenu', selectionTranslatorHotkey: 'Control'})).toMatchObject({
            selectionTranslatorTrigger: 'contextMenu',
            selectionTranslatorHotkey: 'none',
            disableSelectionTranslator: false,
        });
        expect(normalizeConfig({selectionTranslatorHotkey: 'Control'})).toMatchObject({
            selectionTranslatorTrigger: 'Control',
            selectionTranslatorHotkey: 'Control',
        });
        expect(normalizeConfig({selectionTranslatorTrigger: 'custom', selectionTranslatorHotkey: 'custom', customSelectionTranslatorHotkey: 'Ctrl+Shift+Y'})).toMatchObject({
            selectionTranslatorTrigger: 'custom',
            selectionTranslatorHotkey: 'custom',
            customSelectionTranslatorHotkey: 'Ctrl+Shift+Y',
        });
        expect(normalizeConfig({selectionTranslatorTrigger: 'invalid', selectionTranslatorHotkey: 'invalid', customSelectionTranslatorHotkey: 42})).toMatchObject({
            selectionTranslatorTrigger: 'icon',
            selectionTranslatorHotkey: 'none',
            customSelectionTranslatorHotkey: '',
        });
    });

    it('保留三种视觉触发方式，并为每个预设快捷键镜像字段', () => {
        for (const trigger of ['direct', 'icon', 'dot']) {
            expect(normalizeConfig({selectionTranslatorTrigger: trigger, selectionTranslatorHotkey: 'Control'})).toMatchObject({
                selectionTranslatorTrigger: trigger,
                selectionTranslatorHotkey: 'none',
            });
            expect(normalizeConfig({selectionTranslatorTrigger: trigger, selectionTranslatorHotkey: 'none'})).toMatchObject({
                selectionTranslatorTrigger: trigger,
                selectionTranslatorHotkey: 'none',
            });
        }
        for (const trigger of ['Alt', 'Shift']) {
            expect(normalizeConfig({selectionTranslatorTrigger: trigger})).toMatchObject({
                selectionTranslatorTrigger: trigger,
                selectionTranslatorHotkey: trigger,
            });
        }
    });

    it('normalizes and persists the optional TTS voice fallback order', () => {
        expect(new Config().selectionTtsVoices).toEqual([]);
        expect(normalizeConfig({selectionTtsVoices: [
            'en-US-JennyNeural',
            'invalid',
            'en-US-JennyNeural',
            'zh-CN-XiaoyiNeural',
        ]}).selectionTtsVoices).toEqual([
            'en-US-JennyNeural',
            'zh-CN-XiaoyiNeural',
        ]);
    });

    it('keeps the vocabulary book beta opt-in and normalizes invalid values', () => {
        expect(new Config().vocabularyBookEnabled).toBe(false);
        expect(normalizeConfig({vocabularyBookEnabled: true}).vocabularyBookEnabled).toBe(true);
        expect(normalizeConfig({vocabularyBookEnabled: 'yes'}).vocabularyBookEnabled).toBe(false);
    });
});

describe('OpenAI 兼容服务端点', () => {
    it('使用服务商当前公开的统一 Chat Completions 端点', () => {
        expect(urls[services.yiyan]).toBe('https://qianfan.bj.baidubce.com/v2/chat/completions');
        expect(urls[services.minimax]).toBe('https://api.minimaxi.com/v1/chat/completions');
        expect(MINIMAX_ENDPOINTS.payg.cn).toBe('https://api.minimaxi.com/v1/chat/completions');
        expect(MINIMAX_ENDPOINTS['token-plan'].global).toBe('https://api.minimax.io/v1/chat/completions');
        expect(urls[services.infini]).toBe('https://cloud.infini-ai.com/maas/v1/chat/completions');
        expect(urls[services.huanYuan]).toBe('https://api.hunyuan.cloud.tencent.com/v1/chat/completions');
        expect(tongyiTokenPlanUrl).toBe('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
    });

    it('MiniMax 区域配置只接受全球版或中国版', () => {
        expect(new Config().minimaxRegion).toBe('cn');
        expect(normalizeConfig({minimaxRegion: 'cn'}).minimaxRegion).toBe('cn');
        expect(normalizeConfig({minimaxRegion: 'unknown'}).minimaxRegion).toBe('cn');
    });

    it('MiniMax 计费方式只接受按量付费或 Token Plan', () => {
        expect(new Config().minimaxBillingPlan).toBe('payg');
        expect(normalizeConfig({minimaxBillingPlan: 'token-plan'}).minimaxBillingPlan).toBe('token-plan');
        expect(normalizeConfig({minimaxBillingPlan: 'unknown'}).minimaxBillingPlan).toBe('payg');
    });

    it('MiMo 配置独立处理 Token Plan 集群并清理非法值', () => {
        expect(new Config().mimoBillingPlan).toBe('payg');
        expect(new Config().mimoRegion).toBe('cn');
        expect(normalizeConfig({mimoBillingPlan: 'token-plan', mimoRegion: 'sgp'})).toMatchObject({
            mimoBillingPlan: 'token-plan',
            mimoRegion: 'sgp',
        });
        expect(normalizeConfig({mimoBillingPlan: 'unknown', mimoRegion: 'unknown'})).toMatchObject({
            mimoBillingPlan: 'payg',
            mimoRegion: 'cn',
        });
    });

    it('MiMo 按量付费与三套 Token Plan 集群使用不同端点', () => {
        expect(MIMO_ENDPOINTS.payg.cn).toBe('https://api.xiaomimimo.com/v1/chat/completions');
        expect(getMimoEndpoint('token-plan', 'cn')).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
        expect(getMimoEndpoint('token-plan', 'sgp')).toBe('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
        expect(getMimoEndpoint('token-plan', 'ams')).toBe('https://token-plan-ams.xiaomimimo.com/v1/chat/completions');
        expect(getMimoEndpoint('payg', 'ams')).toBe('https://api.xiaomimimo.com/v1/chat/completions');
        expect(getMimoEndpoint('token-plan', 'invalid')).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    });

    it('文心一言使用 Bearer Token，不再要求旧 AK/SK', () => {
        expect(servicesType.isUseToken(services.yiyan)).toBe(true);
    });
});

it('图片入口偏好默认开启并保留独立关闭状态', () => {
    expect(new Config().imageTranslationHoverEnabled).toBe(true);
    expect(new Config().imageTranslationContextMenuEnabled).toBe(true);
    expect(normalizeConfig({}).imageTranslationHoverEnabled).toBe(true);
    expect(normalizeConfig({imageTranslationHoverEnabled: 'false'}).imageTranslationHoverEnabled).toBe(true);
    expect(normalizeConfig({imageTranslationHoverEnabled: false}).imageTranslationHoverEnabled).toBe(false);
    expect(normalizeConfig({imageTranslationContextMenuEnabled: false}).imageTranslationContextMenuEnabled).toBe(false);
    expect(normalizeConfig({imageTranslationContextMenuEnabled: 'false'}).imageTranslationContextMenuEnabled).toBe(true);
});

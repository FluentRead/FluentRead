import {describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {}}));

import {
    AI_SDK_COMMON_SERVICE_IDS,
    AI_SDK_SERVICE_IDS,
    AI_SDK_TRANSPORT_PROFILE,
    getAiSdkEndpointRoute,
    normalizeNewApiEndpoint,
    parseChatCompletionsEndpoint,
    resolveOpenAICompatibleEndpoint,
    type AiSdkEndpointConfig,
} from '@/src/providers/translation/ai-sdk/endpoints';
import {services} from '@/src/core/config/catalog';
import {urls} from '@/src/core/config/constants';
import {isValidAzureEndpoint, normalizeAzureEndpoint} from '@/src/core/config/azure';

function endpointConfig(overrides: Partial<AiSdkEndpointConfig> = {}): AiSdkEndpointConfig {
    return {
        proxy: {},
        custom: 'http://localhost:11434/v1/chat/completions',
        newApiUrl: 'http://localhost:3000',
        azureOpenaiEndpoint: 'https://reader.openai.azure.com/openai/deployments/translation/chat/completions?api-version=2024-02-15-preview',
        minimaxBillingPlan: 'payg',
        minimaxRegion: 'cn',
        mimoBillingPlan: 'payg',
        mimoRegion: 'cn',
        ...overrides,
    };
}

describe('AI SDK 首批服务路由', () => {
    it('暴露稳定的 transport profile 供缓存隔离', () => {
        expect(AI_SDK_TRANSPORT_PROFILE).toBe('vercel-ai-sdk-openai-compatible-v1');
    });

    it('精确覆盖 23 个 common 服务和 3 个专用入口', () => {
        expect(AI_SDK_COMMON_SERVICE_IDS).toEqual([
            services.yiyan,
            services.infini,
            services.minimax,
            services.mimo,
            services.openai,
            services.moonshot,
            services.baichuan,
            services.lingyi,
            services.jieyue,
            services.groq,
            services.huanYuan,
            services.doubao,
            services.siliconCloud,
            services.openrouter,
            services.grok,
            services.ollama,
            services.mistral,
            services.cohere,
            services.togetherai,
            services.fireworks,
            services.cerebras,
            services.deepinfra,
            services.perplexity,
            services.runcrate,
        ]);
        expect(new Set(AI_SDK_SERVICE_IDS).size).toBe(27);
        expect(getAiSdkEndpointRoute(services.custom)).toBe('custom');
        expect(getAiSdkEndpointRoute(services.newapi)).toBe('newapi');
        expect(getAiSdkEndpointRoute(services.azureOpenai)).toBe('azure');
        expect(getAiSdkEndpointRoute(services.deepseek)).toBeNull();
    });

    it.each([
        [services.yiyan, 'https://qianfan.bj.baidubce.com/v2/chat/completions', 'https://qianfan.bj.baidubce.com/v2'],
        [services.infini, 'https://cloud.infini-ai.com/maas/v1/chat/completions', 'https://cloud.infini-ai.com/maas/v1'],
        [services.minimax, 'https://api.minimaxi.com/v1/chat/completions', 'https://api.minimaxi.com/v1'],
        [services.mimo, 'https://api.xiaomimimo.com/v1/chat/completions', 'https://api.xiaomimimo.com/v1'],
        [services.openai, 'https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1'],
        [services.moonshot, 'https://api.moonshot.cn/v1/chat/completions', 'https://api.moonshot.cn/v1'],
        [services.baichuan, 'https://api.baichuan-ai.com/v1/chat/completions', 'https://api.baichuan-ai.com/v1'],
        [services.lingyi, 'https://api.lingyiwanwu.com/v1/chat/completions', 'https://api.lingyiwanwu.com/v1'],
        [services.jieyue, 'https://api.stepfun.com/v1/chat/completions', 'https://api.stepfun.com/v1'],
        [services.groq, 'https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1'],
        [services.huanYuan, 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', 'https://api.hunyuan.cloud.tencent.com/v1'],
        [services.doubao, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'https://ark.cn-beijing.volces.com/api/v3'],
        [services.siliconCloud, 'https://api.siliconflow.cn/v1/chat/completions', 'https://api.siliconflow.cn/v1'],
        [services.openrouter, 'https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1'],
        [services.grok, 'https://api.x.ai/v1/chat/completions', 'https://api.x.ai/v1'],
        [services.custom, 'http://localhost:11434/v1/chat/completions', 'http://localhost:11434/v1'],
        [services.newapi, 'http://localhost:3000/v1/chat/completions', 'http://localhost:3000/v1'],
        [services.azureOpenai, 'https://reader.openai.azure.com/openai/deployments/translation/chat/completions?api-version=2024-02-15-preview', 'https://reader.openai.azure.com/openai/deployments/translation'],
    ])('%s 解析为当前请求 URL 和 SDK baseURL', (service, endpoint, baseURL) => {
        const result = resolveOpenAICompatibleEndpoint(service, endpointConfig());

        expect(result.endpoint).toBe(endpoint);
        expect(result.baseURL).toBe(baseURL);
        expect(result.queryParams).toEqual(service === services.azureOpenai
            ? {'api-version': '2024-02-15-preview'}
            : undefined);
        expect(result.exactEndpoint).toBeUndefined();
    });
});

describe('AI SDK endpoint 选择规则', () => {
    it.each([
        ['https://opencode.ai/zen/v1', 'https://opencode.ai/zen/v1/chat/completions'],
        [' https://opencode.ai/zen/go/v1/// ', 'https://opencode.ai/zen/go/v1/chat/completions'],
        ['http://localhost:11434/', 'http://localhost:11434/v1/chat/completions'],
        ['https://gateway.example/api/v2?region=cn#ignored', 'https://gateway.example/api/v2/chat/completions?region=cn'],
    ])('issue #626：自定义 Base URL %s 补全 Chat Completions', (input, endpoint) => {
        const config = endpointConfig({custom: input});
        expect(resolveOpenAICompatibleEndpoint(services.custom, config).endpoint).toBe(endpoint);
        expect(config.custom).toBe(input);
        expect(resolveOpenAICompatibleEndpoint('custom:zen', {
            customOpenAIProviders: [{id: 'custom:zen', name: 'Zen', endpoint: input, models: ['big-pickle']}],
        }).endpoint).toBe(endpoint);
    });

    it('issue #626：Base URL 补全后保留重复查询键与编码', () => {
        const endpoint = 'https://opencode.ai/zen/v1/chat/completions?tenant=a&tenant=b&sig=a%2Fb';
        const resolved = resolveOpenAICompatibleEndpoint('custom:zen', {
            customOpenAIProviders: [{id: 'custom:zen', name: 'Zen', endpoint: 'https://opencode.ai/zen/v1?tenant=a&tenant=b&sig=a%2Fb#ignored', models: ['big-pickle']}],
            proxy: {'custom:zen': '  '},
        });
        expect(resolved).toEqual({endpoint, baseURL: 'https://opencode.ai/zen/v1', exactEndpoint: endpoint});
    });

    it.each(['https://relay.example/', 'https://relay.example/v1?tenant=a&tenant=b'])('issue #626：显式代理 %s 保留完整请求目标', proxy => {
        expect(resolveOpenAICompatibleEndpoint('custom:zen', {
            customOpenAIProviders: [{id: 'custom:zen', name: 'Zen', endpoint: 'https://opencode.ai/zen/v1', models: ['big-pickle']}],
            proxy: {'custom:zen': proxy},
        }).exactEndpoint).toBe(proxy);
    });

    it('issue #626：不改写内置服务的显式代理或自定义非标准接口', () => {
        expect(resolveOpenAICompatibleEndpoint(services.openai, {proxy: {openai: 'https://gateway.example/v1'}}).exactEndpoint)
            .toBe('https://gateway.example/v1');
        for (const custom of ['https://gateway.example/translate/', 'https://gateway.example/v1/responses', 'https://gateway.example/v1/messages']) {
            expect(resolveOpenAICompatibleEndpoint(services.custom, {custom}).exactEndpoint).toBe(custom);
        }
    });

    it('显式空代理配置使用服务目录的默认端点', () => {
        expect(resolveOpenAICompatibleEndpoint(services.openai, endpointConfig()).endpoint).toBe(urls[services.openai]);
    });

    it('common 服务优先使用当前服务的代理地址', () => {
        const proxy = 'https://gateway.example.com/openai/v1/chat/completions';
        const result = resolveOpenAICompatibleEndpoint(services.openai, endpointConfig({
            proxy: {[services.openai]: proxy},
        }));

        expect(result.endpoint).toBe(proxy);
        expect(result.baseURL).toBe('https://gateway.example.com/openai/v1');
    });

    it('Custom 代理地址优先于自定义接口', () => {
        const proxy = 'http://127.0.0.1:8080/v1/chat/completions';
        const result = resolveOpenAICompatibleEndpoint(services.custom, endpointConfig({
            proxy: {[services.custom]: proxy},
            custom: 'http://127.0.0.1:11434/v1/chat/completions',
        }));

        expect(result.endpoint).toBe(proxy);
        expect(result.baseURL).toBe('http://127.0.0.1:8080/v1');
    });

    it('Custom 在没有 proxy 对象时直接使用自定义接口', () => {
        const result = resolveOpenAICompatibleEndpoint(services.custom, {
            custom: 'http://127.0.0.1:11434/v1/chat/completions',
        });

        expect(result.endpoint).toBe('http://127.0.0.1:11434/v1/chat/completions');
    });

    it('动态 custom:* 服务按 profile ID 解析各自端点并保留代理优先级', () => {
        const customOpenAIProviders = [
            {id: 'custom:1', name: '本地', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', models: ['local-model']},
            {id: 'custom:2', name: '远程', endpoint: 'https://remote.example/v1/chat/completions', models: ['remote-model']},
        ];

        expect(getAiSdkEndpointRoute('custom:1')).toBe('custom');
        expect(resolveOpenAICompatibleEndpoint('custom:1', endpointConfig({customOpenAIProviders})).endpoint)
            .toBe('http://127.0.0.1:11434/v1/chat/completions');
        expect(resolveOpenAICompatibleEndpoint('custom:2', endpointConfig({
            customOpenAIProviders,
            proxy: {'custom:2': 'https://gateway.example/v1/chat/completions'},
        })).endpoint).toBe('https://gateway.example/v1/chat/completions');
        expect(() => resolveOpenAICompatibleEndpoint('custom:3', endpointConfig({customOpenAIProviders})))
            .toThrow('custom:3 接口地址未配置');
    });

    it('MiniMax 保留计费方案和区域选择', () => {
        const result = resolveOpenAICompatibleEndpoint(services.minimax, endpointConfig({
            minimaxBillingPlan: 'token-plan',
            minimaxRegion: 'global',
        }));

        expect(result.endpoint).toBe('https://api.minimax.io/v1/chat/completions');
    });

    it('MiMo 保留 Token Plan 集群选择', () => {
        const result = resolveOpenAICompatibleEndpoint(services.mimo, endpointConfig({
            mimoBillingPlan: 'token-plan',
            mimoRegion: 'ams',
        }));

        expect(result.endpoint).toBe('https://token-plan-ams.xiaomimimo.com/v1/chat/completions');
    });

    it('MiniMax 与 MiMo 对未知计费参数回退到既有默认值', () => {
        expect(resolveOpenAICompatibleEndpoint(services.minimax, endpointConfig({
            minimaxBillingPlan: 'unknown',
            minimaxRegion: 'unknown',
        })).endpoint).toBe('https://api.minimaxi.com/v1/chat/completions');
        expect(resolveOpenAICompatibleEndpoint(services.mimo, endpointConfig({
            mimoBillingPlan: '',
            mimoRegion: '',
        })).endpoint).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    });

    it('空白代理不覆盖默认端点，缺失的 common URL 会显式失败', () => {
        expect(resolveOpenAICompatibleEndpoint(services.openai, endpointConfig({
            proxy: {[services.openai]: '   '},
        })).endpoint).toBe(urls[services.openai]);

        const original = urls[services.openai];
        try {
            delete urls[services.openai];
            expect(() => resolveOpenAICompatibleEndpoint(services.openai, endpointConfig()))
                .toThrow(`未找到翻译服务接口: ${services.openai}`);
        } finally {
            urls[services.openai] = original;
        }
    });

    it('Azure 从完整部署 URL 拆出 api-version', () => {
        const result = resolveOpenAICompatibleEndpoint(services.azureOpenai, endpointConfig());

        expect(result.queryParams).toEqual({'api-version': '2024-02-15-preview'});
        expect(result.baseURL).toBe('https://reader.openai.azure.com/openai/deployments/translation');
    });

    it.each([
        [services.deepseek, {}, '尚未纳入 AI SDK 端点解析'],
        [services.custom, {}, '接口地址未配置'],
        [services.newapi, {}, 'New API 地址未配置'],
        [services.azureOpenai, {}, '接口地址未配置'],
    ])('%s 缺少路由或必要地址时给出明确错误', (service, config, message) => {
        expect(() => resolveOpenAICompatibleEndpoint(service, config)).toThrow(message);
    });
});

describe('Chat Completions URL 拆分', () => {
    it('拒绝语法无效的绝对 URL，并保留调用方标签', () => {
        expect(() => parseChatCompletionsEndpoint('not a url', '自定义地址')).toThrow('自定义地址格式不正确');
    });

    it('支持位于站点根路径且带尾斜杠的 Chat Completions URL', () => {
        const result = parseChatCompletionsEndpoint('https://gateway.example.com/chat/completions/');

        expect(result.endpoint).toBe('https://gateway.example.com/chat/completions');
        expect(result.baseURL).toBe('https://gateway.example.com');
    });
    it('拆分完整路径并保留查询参数', () => {
        const result = parseChatCompletionsEndpoint(
            'https://gateway.example.com/api/v1/chat/completions?api-version=2026-01-01&region=cn#ignored',
        );

        expect(result.endpoint).toBe('https://gateway.example.com/api/v1/chat/completions?api-version=2026-01-01&region=cn');
        expect(result.baseURL).toBe('https://gateway.example.com/api/v1');
        expect(result.queryParams).toEqual({'api-version': '2026-01-01', region: 'cn'});
        expect(result.exactEndpoint).toBeUndefined();
    });

    it('重复查询参数改用 exactEndpoint，避免 Record 归一化丢值', () => {
        const endpoint = 'https://gateway.example.com/v1/chat/completions?feature=a&feature=b';
        const result = parseChatCompletionsEndpoint(endpoint);

        expect(result.endpoint).toBe(endpoint);
        expect(result.queryParams).toBeUndefined();
        expect(result.exactEndpoint).toBe(endpoint);
    });

    it('非标准 Custom 路径返回 exactEndpoint，供后续 fetch rewrite 使用', () => {
        const result = resolveOpenAICompatibleEndpoint(services.custom, endpointConfig({
            custom: 'https://local.example.com/api/generate?mode=translate',
        }));

        expect(result.baseURL).toBe('https://local.example.com/api/generate');
        expect(result.queryParams).toEqual({mode: 'translate'});
        expect(result.exactEndpoint).toBe('https://local.example.com/api/generate?mode=translate');
    });
});

describe('Azure URL 规范化', () => {
    it.each([
        ['https://reader.openai.azure.com', 'https://reader.openai.azure.com/openai/v1/chat/completions'],
        [' https://reader.services.ai.azure.com/ ', 'https://reader.services.ai.azure.com/openai/v1/chat/completions'],
        ['https://reader.openai.azure.com/openai/v1', 'https://reader.openai.azure.com/openai/v1/chat/completions'],
        ['https://reader.services.ai.azure.com/openai/v1/', 'https://reader.services.ai.azure.com/openai/v1/chat/completions'],
        ['http://localhost:3000/v1/', 'http://localhost:3000/v1/chat/completions'],
        ['https://gateway.example/api/chat/completions/', 'https://gateway.example/api/chat/completions'],
        ['https://reader.services.ai.azure.com/openai/v1/chat/completions', 'https://reader.services.ai.azure.com/openai/v1/chat/completions'],
        ['https://reader.openai.azure.com/openai/deployments/reader/chat/completions?api-version=2024-10-21', 'https://reader.openai.azure.com/openai/deployments/reader/chat/completions?api-version=2024-10-21'],
        ['https://reader.openai.azure.cn/?tenant=reader#ignored', 'https://reader.openai.azure.cn/openai/v1/chat/completions?tenant=reader'],
    ])('%s -> %s，UI 与请求端遵循同一规则', (input, expected) => {
        expect(normalizeAzureEndpoint(input)).toBe(expected);
        expect(isValidAzureEndpoint(input)).toBe(true);
        expect(resolveOpenAICompatibleEndpoint(services.azureOpenai, {azureOpenaiEndpoint: input}).endpoint)
            .toBe(expected);
    });

    it('v1 默认不注入日期版本，重复查询值保留 exactEndpoint', () => {
        const base = 'https://reader.services.ai.azure.com/openai/v1';
        const resolved = resolveOpenAICompatibleEndpoint(services.azureOpenai, {azureOpenaiEndpoint: base});
        expect(resolved.baseURL).toBe(base);
        expect(resolved.queryParams).toBeUndefined();
        expect(resolved.endpoint).not.toContain('api-version');

        const duplicated = resolveOpenAICompatibleEndpoint(services.azureOpenai, {
            azureOpenaiEndpoint: `${base}?tenant=a&tenant=b#ignored`,
        });
        expect(duplicated.exactEndpoint).toBe(`${base}/chat/completions?tenant=a&tenant=b`);
        expect(duplicated.queryParams).toBeUndefined();
    });

    it.each([
        ['', 'Azure 接口地址未配置'],
        ['   ', 'Azure 接口地址未配置'],
        ['not a url', 'Azure 端点地址格式不正确'],
        ['ftp://reader.openai.azure.com', '仅支持 HTTP 或 HTTPS'],
        ['https://user@reader.openai.azure.com', '不能包含用户名或密码'],
        ['https://:secret@reader.openai.azure.com', '不能包含用户名或密码'],
        ['https://reader.openai.azure.com/openai/deployments/reader', '完整的 Chat Completions'],
        ['https://reader.openai.azure.com/openai/v1/responses', '完整的 Chat Completions'],
        ['https://reader.openai.azure.com/unexpected', '完整的 Chat Completions'],
    ])('拒绝不可请求的地址 %s', (input, message) => {
        expect(() => normalizeAzureEndpoint(input)).toThrow(message);
        expect(isValidAzureEndpoint(input)).toBe(false);
    });
});

describe('New API URL 规范化', () => {
    it.each([
        ['http://localhost:3000', 'http://localhost:3000/v1/chat/completions'],
        ['http://localhost:3000/', 'http://localhost:3000/v1/chat/completions'],
        ['http://localhost:3000/v1', 'http://localhost:3000/v1/chat/completions'],
        ['http://localhost:3000/v1/', 'http://localhost:3000/v1/chat/completions'],
        ['http://localhost:3000/v1/chat/completions', 'http://localhost:3000/v1/chat/completions'],
        ['https://gateway.example.com/api?tenant=reader', 'https://gateway.example.com/api/v1/chat/completions?tenant=reader'],
    ])('%s -> %s', (input, expected) => {
        expect(normalizeNewApiEndpoint(input)).toBe(expected);
    });

    it('拒绝空地址和非 HTTP(S) 协议', () => {
        expect(() => normalizeNewApiEndpoint('')).toThrow('New API 地址未配置');
        expect(() => normalizeNewApiEndpoint('file:///tmp/api')).toThrow('仅支持 HTTP 或 HTTPS');
    });
});

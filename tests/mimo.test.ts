import {withProviderSnapshot} from './helpers/providerSnapshot';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, mockConfig } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    mockConfig: {
        service: 'mimo',
        to: 'zh-Hans',
        token: { mimo: '' } as Record<string, string>,
        model: { mimo: 'mimo-v2.6-pro' } as Record<string, string>,
        customModel: {} as Record<string, string>,
        customBody: {} as Record<string, string>,
        proxy: {} as Record<string, string>,
        system_role: { mimo: 'You are a translator.' } as Record<string, string>,
        user_role: { mimo: 'Translate to {{to}}: {{origin}}' } as Record<string, string>,
        mimoBillingPlan: 'payg',
        mimoRegion: 'cn',
    },
}));

vi.mock('@/src/services/config/store', () => ({ config: mockConfig }));

import {translateWithOpenAICompatibleAiSdk} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {getFeatureModel, featureServiceDefinitions} from '@/src/core/config/featureServices';
import {normalizeConfig} from '@/src/core/config/model';
import {translateWithOpenAICompatibleAiSdk as standalone} from '@/userscript/openaiCompatible';
import {customModelString, services } from '@/src/core/config/catalog';

function successResponse() {
    return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'mimo-v2.6-pro',
        choices: [{index: 0, message: {role: 'assistant', content: '译文'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
    }), {
        status: 200,
        headers: {'content-type': 'application/json'},
    });
}

describe('小米 MiMo OpenAI 兼容服务', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockResolvedValue(successResponse());
        mockConfig.service = services.mimo;
        mockConfig.model = {mimo: 'mimo-v2.6-pro'};
        mockConfig.customModel = {};
        mockConfig.customBody = {};
        mockConfig.proxy = {};
        mockConfig.token.mimo = '';
        mockConfig.mimoBillingPlan = 'payg';
        mockConfig.mimoRegion = 'cn';
    });

    it('按量付费使用统一 API 地址并发送 sk Key', async () => {
        mockConfig.token.mimo = 'sk-test';

        await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({ origin: 'hello', serviceOverride: services.mimo }, mockConfig))).resolves.toBe('译文');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.xiaomimimo.com/v1/chat/completions',
            expect.objectContaining({ method: 'POST' }),
        );
        const headers = new Headers(fetchMock.mock.calls[0][1].headers);
        expect(headers.get('Authorization')).toBe('Bearer sk-test');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('mimo-v2.6-pro');
    });

    it('Token Plan 使用所选集群地址并发送 tp Key', async () => {
        mockConfig.token.mimo = 'tp-test';
        mockConfig.mimoBillingPlan = 'token-plan';
        mockConfig.mimoRegion = 'ams';

        await expect(translateWithOpenAICompatibleAiSdk(withProviderSnapshot({ origin: 'hello', serviceOverride: services.mimo }, mockConfig))).resolves.toBe('译文');

        expect(fetchMock).toHaveBeenCalledWith(
            'https://token-plan-ams.xiaomimimo.com/v1/chat/completions',
            expect.objectContaining({ method: 'POST' }),
        );
        const headers = new Headers(fetchMock.mock.calls[0][1].headers);
        expect(headers.get('Authorization')).toBe('Bearer tp-test');
    });
});


describe('MiMo 退役编号最终请求回归', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockImplementation(async () => successResponse());
    });

    const retired = [
        ['mimo-v2.5', 'mimo-v2.6-flash'],
        ['mimo-v2.5-pro', 'mimo-v2.6-pro'],
    ] as const;

    it.each(retired)('历史自定义 %s 在网页和文档请求中更新，持久配置保持幂等', async (oldModel, nextModel) => {
        const saved = normalizeConfig({
            service: services.mimo, documentService: services.mimo,
            model: {mimo: customModelString}, customModel: {mimo: oldModel},
            documentModel: {mimo: customModelString}, documentCustomModel: {mimo: oldModel},
            customModels: {mimo: [oldModel]}, modelThinking: {mimo: {[oldModel]: true}},
            customBody: {mimo: JSON.stringify({thinking: {type: 'enabled'}, max_completion_tokens: 512})},
        });
        const original = JSON.stringify(saved);
        for (const document of [false, true]) {
            const modelOverride = document
                ? getFeatureModel(saved, featureServiceDefinitions.find(feature => feature.id === 'document')!)
                : undefined;
            await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'hello', modelOverride}, saved));
            expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toMatchObject({
                model: nextModel, thinking: {type: 'enabled'}, max_completion_tokens: 512,
            });
        }
        expect(JSON.stringify(saved)).toBe(original);
        expect(normalizeConfig(saved)).toEqual(saved);
    });

    it.each(['cn', 'sgp', 'ams'])('Token Plan %s 的高级请求体不能重新带回旧编号', async region => {
        await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'hello'}, {
            ...mockConfig, service: services.mimo, mimoBillingPlan: 'token-plan', mimoRegion: region,
            model: {mimo: 'mimo-v2.6-flash'},
            customBody: {mimo: JSON.stringify({model: ' mimo-v2.5-pro ', temperature: 0.4})},
        }));
        expect(fetchMock.mock.lastCall![0]).toBe(`https://token-plan-${region}.xiaomimimo.com/v1/chat/completions`);
        expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toMatchObject({model: 'mimo-v2.6-pro', temperature: 0.4});
    });

    it.each([['SDK', translateWithOpenAICompatibleAiSdk], ['standalone', standalone]] as const)
    ('%s 自定义 OpenAI 服务直连官方时，覆盖模型也经过最终映射', async (_name, translate) => {
        await translate(withProviderSnapshot({origin: 'hello', modelOverride: 'mimo-v2.5-pro'}, {
            ...mockConfig, service: services.custom, custom: 'https://api.xiaomimimo.com/v1',
            model: {custom: 'mimo-v2.6-pro'}, customBody: {custom: '{"model":"mimo-v2.5"}'},
        }));
        expect(JSON.parse(fetchMock.mock.lastCall![1].body).model).toBe('mimo-v2.6-flash');
    });

    it.each([
        'https://gateway.example/v1/chat/completions',
        'https://api.xiaomimimo.com.example/v1/chat/completions',
        'https://api.xiaomimimo.com:8443/v1/chat/completions',
        'http://api.xiaomimimo.com/v1/chat/completions',
    ])('保留非官方 origin %s 的自定义别名', async endpoint => {
        await translateWithOpenAICompatibleAiSdk(withProviderSnapshot({origin: 'hello'}, {
            ...mockConfig, service: services.mimo, proxy: {mimo: endpoint},
            model: {mimo: customModelString}, customModel: {mimo: 'mimo-v2.5'},
        }));
        expect(JSON.parse(fetchMock.mock.lastCall![1].body).model).toBe('mimo-v2.5');
    });

    it.each(['mimo-v2.6-flash', 'mimo-v2.6-pro', 'private-mimo-v2.5', 'mimo-v2.5-preview'])
    ('官方端点不猜测其他模型 %s 的替代编号', async model => {
        await standalone(withProviderSnapshot({origin: 'hello'}, {
            ...mockConfig, service: services.mimo, proxy: {},
            model: {mimo: customModelString}, customModel: {mimo: model},
        }));
        expect(JSON.parse(fetchMock.mock.lastCall![1].body).model).toBe(model);
    });
});

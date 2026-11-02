import {describe, expect, it} from 'vitest';

import {services} from '@/src/core/config/catalog';
import {
    hasModelThinkingPreference,
    isModelThinkingEnabled,
    normalizeModelThinkingMapping,
    withModelThinkingPreference,
    withoutModelThinkingPreference,
} from '@/src/core/config/modelThinking';
import {applyModelThinkingPreference} from '@/src/services/translation/modelThinking';

describe('模型级 Thinking 配置', () => {
    it('只保留非空服务和模型下的布尔值', () => {
        expect(normalizeModelThinkingMapping(null)).toEqual({});
        expect(normalizeModelThinkingMapping('invalid')).toEqual({});
        expect(normalizeModelThinkingMapping([])).toEqual({});
        expect(normalizeModelThinkingMapping({
            '': {'model-a': true},
            openai: null,
            empty: {'': true, '   ': false, invalid: 'true'},
            valid: {'model-a': true, 'model-b': false, invalid: 1},
        })).toEqual({
            valid: {'model-a': true, 'model-b': false},
        });
    });

    it('缺省为关闭，但能区分显式 false', () => {
        const mapping = {openai: {'model-a': false, 'model-b': true}};
        expect(isModelThinkingEnabled(mapping, 'openai', 'missing')).toBe(false);
        expect(isModelThinkingEnabled(undefined, 'openai', 'model-a')).toBe(false);
        expect(isModelThinkingEnabled(mapping, 'openai', 'model-a')).toBe(false);
        expect(isModelThinkingEnabled(mapping, 'openai', 'model-b')).toBe(true);
        expect(hasModelThinkingPreference(mapping, 'openai', 'model-a')).toBe(true);
        expect(hasModelThinkingPreference(mapping, 'openai', 'missing')).toBe(false);
        expect(hasModelThinkingPreference(undefined, 'openai', 'model-a')).toBe(false);
    });

    it('不可变地写入和删除单模型或整个服务，并清理畸形源值', () => {
        const source = {
            openai: {'model-a': true, malformed: 'yes' as unknown as boolean},
            gemini: {'model-b': false},
        };
        const updated = withModelThinkingPreference(source, 'openai', 'model-c', false);
        expect(updated).toEqual({
            openai: {'model-a': true, 'model-c': false},
            gemini: {'model-b': false},
        });
        expect(source.openai).toHaveProperty('malformed');
        expect(withModelThinkingPreference(updated, 'claude', 'model-d', true).claude)
            .toEqual({'model-d': true});
        expect(withModelThinkingPreference(updated, '', 'model-d', true)).toEqual(updated);
        expect(withModelThinkingPreference(updated, 'openai', '   ', true)).toEqual(updated);

        expect(withoutModelThinkingPreference(updated, 'missing', 'model-a')).toEqual(updated);
        expect(withoutModelThinkingPreference(updated, 'openai', 'model-a')).toEqual({
            openai: {'model-c': false},
            gemini: {'model-b': false},
        });
        expect(withoutModelThinkingPreference(updated, 'gemini', 'model-b')).toEqual({
            openai: {'model-a': true, 'model-c': false},
        });
        expect(withoutModelThinkingPreference(updated, 'openai')).toEqual({
            gemini: {'model-b': false},
        });
    });
});

describe('模型 Thinking 协议映射', () => {
    const apply = (
        protocol: Parameters<typeof applyModelThinkingPreference>[1]['protocol'],
        service: string,
        model: string,
        enabled: boolean,
        payload: Record<string, unknown> = {model},
    ) => applyModelThinkingPreference(payload, {protocol, service, model, enabled});

    it.each(['deepseek-v4-flash', 'deepseek-flash'])('映射 DeepSeek Chat 的 %s 开关字段', (model) => {
        expect(apply('deepseek-chat', services.deepseek, model, true)).toEqual({
            effect: 'toggle',
            payload: {model, thinking: {type: 'enabled'}},
        });
        expect(apply('deepseek-chat', services.deepseek, model, false).payload)
            .toMatchObject({thinking: {type: 'disabled'}});
    });

    it.each(['deepseek-v4-flash', 'deepseek-flash'])('映射 DeepSeek Responses 的 %s 开关字段', (model) => {
        expect(apply('deepseek-responses', services.deepseek, model, true).payload)
            .toMatchObject({reasoning: {effort: 'high'}});
        expect(apply('deepseek-responses', services.deepseek, model, false).payload)
            .toMatchObject({reasoning: {effort: 'none'}});
    });

    it('只给通义已确认的混合思考模型添加布尔开关', () => {
        expect(apply('tongyi-chat', services.tongyi, 'qwen3.7-plus', true).payload)
            .toMatchObject({enable_thinking: true});
        expect(apply('tongyi-chat', services.tongyi, 'qwen3.7-plus', false).payload)
            .toMatchObject({enable_thinking: false});
        expect(apply('tongyi-chat', services.tongyi, 'qwen-mt-plus', true))
            .toEqual({effect: 'unsupported', payload: {model: 'qwen-mt-plus'}});
        expect(apply('tongyi-chat', services.tongyi, 'qwen3-235b-a22b-thinking-2507', false))
            .toEqual({effect: 'unsupported', payload: {model: 'qwen3-235b-a22b-thinking-2507'}});
        expect(apply('tongyi-chat', services.tongyi, 'qwen-long-latest', true))
            .toEqual({effect: 'unsupported', payload: {model: 'qwen-long-latest'}});
    });

    it.each([
        ['gemini-2.5-flash', true, 'toggle', {thinkingBudget: -1}],
        ['gemini-2.5-flash-lite', false, 'toggle', {thinkingBudget: 0}],
        ['gemini-2.5-pro', true, 'toggle', {thinkingBudget: -1}],
        ['gemini-2.5-pro', false, 'minimum', {thinkingBudget: 128}],
        ['gemini-3.7-flash', true, 'toggle', {thinkingLevel: 'medium'}],
        ['gemini-3.7-flash', false, 'minimum', {thinkingLevel: 'low'}],
        ['gemini-3.8-flash', true, 'toggle', {thinkingLevel: 'medium'}],
        ['gemini-3.8-flash', false, 'minimum', {thinkingLevel: 'low'}],
        ['gemini-4-argon', true, 'toggle', {thinkingLevel: 'medium'}],
        ['gemini-4-argon', false, 'minimum', {thinkingLevel: 'low'}],
        ['gemini-3-flash', false, 'minimum', {thinkingLevel: 'minimal'}],
        ['gemini-3.1-flash-lite', true, 'toggle', {thinkingLevel: 'medium'}],
        ['gemini-3.5-flash', false, 'minimum', {thinkingLevel: 'minimal'}],
        ['gemini-3.6-flash', true, 'toggle', {thinkingLevel: 'medium'}],
        ['gemini-3.1-pro-preview', false, 'minimum', {thinkingLevel: 'low'}],
        ['gemini-3-pro-preview', true, 'toggle', {thinkingLevel: 'high'}],
    ] as const)('映射 Gemini %s 的 %s 状态', (model, enabled, effect, thinkingConfig) => {
        const result = apply(
            'gemini-generate-content',
            services.gemini,
            model,
            enabled,
            {generationConfig: {temperature: 0}},
        );
        expect(result.effect).toBe(effect);
        expect(result.payload).toEqual({
            generationConfig: {temperature: 0, thinkingConfig},
        });
    });

    it('未知 Gemini 模型不猜字段，并防御畸形 generationConfig', () => {
        const payload = {generationConfig: []};
        expect(apply('gemini-generate-content', services.gemini, 'gemini-future', true, payload))
            .toEqual({effect: 'unsupported', payload});
        for (const specializedModel of [
            'gemini-3.1-flash-lite-image',
            'gemini-2.5-flash-preview-tts',
            'gemini-live-2.5-flash-preview',
        ]) {
            expect(apply('gemini-generate-content', services.gemini, specializedModel, true, payload))
                .toEqual({effect: 'unsupported', payload});
        }
        expect(apply('gemini-generate-content', services.gemini, 'gemini-2.5-flash', false, payload).payload)
            .toEqual({generationConfig: {thinkingConfig: {thinkingBudget: 0}}});
        expect(apply(
            'gemini-generate-content',
            services.gemini,
            'gemini-2.5-flash',
            false,
            {generationConfig: 1},
        ).payload).toEqual({generationConfig: {thinkingConfig: {thinkingBudget: 0}}});
        expect(apply('gemini-generate-content', services.gemini, 'gemini-2.5-flash', false, {}).payload)
            .toEqual({generationConfig: {thinkingConfig: {thinkingBudget: 0}}});
    });

    it('映射 Claude 可切换与强制思考模型，未知模型保持不变', () => {
        expect(apply('claude-messages', services.claude, 'claude-fable-5', true))
            .toMatchObject({effect: 'mandatory', payload: {thinking: {type: 'adaptive'}}});
        expect(apply('claude-messages', services.claude, 'claude-mythos-5', false))
            .toEqual({
                effect: 'mandatory',
                payload: {
                    model: 'claude-mythos-5',
                    thinking: {type: 'adaptive'},
                    output_config: {effort: 'low'},
                },
            });
        expect(apply(
            'claude-messages',
            services.claude,
            'claude-fable-5',
            false,
            {output_config: {verbosity: 'low'}},
        ).payload).toEqual({
            thinking: {type: 'adaptive'},
            output_config: {verbosity: 'low', effort: 'low'},
        });
        expect(apply(
            'claude-messages',
            services.claude,
            'claude-fable-5',
            false,
            {output_config: []},
        ).payload).toEqual({
            output_config: {effort: 'low'},
            thinking: {type: 'adaptive'},
        });
        expect(apply(
            'claude-messages',
            services.claude,
            'claude-fable-5',
            false,
            {output_config: 'invalid'},
        ).payload).toEqual({
            output_config: {effort: 'low'},
            thinking: {type: 'adaptive'},
        });
        expect(apply('claude-messages', services.claude, 'claude-sonnet-5', true).payload)
            .toMatchObject({thinking: {type: 'adaptive'}});
        expect(apply('claude-messages', services.claude, 'claude-opus-4-6', false).payload)
            .toMatchObject({thinking: {type: 'disabled'}});
        expect(apply('claude-messages', services.claude, 'claude-haiku-4-5', true).payload)
            .toMatchObject({thinking: {type: 'enabled', budget_tokens: 1024}});
        expect(apply('claude-messages', services.claude, 'claude-sonnet-4-5', false).payload)
            .toMatchObject({thinking: {type: 'disabled'}});
        expect(apply(
            'claude-messages',
            services.claude,
            'claude-haiku-4-5',
            true,
            {model: 'claude-haiku-4-5', max_tokens: 1024},
        )).toEqual({
            effect: 'unsupported',
            payload: {model: 'claude-haiku-4-5', max_tokens: 1024},
        });
        expect(apply('claude-messages', services.claude, 'claude-haiku-4-0', true))
            .toEqual({effect: 'unsupported', payload: {model: 'claude-haiku-4-0'}});
    });

    it('按 Claude 5.5 的不同能力生成有效的思考字段', () => {
        expect(apply('claude-messages', services.claude, 'claude-opus-5-5', false))
            .toMatchObject({effect: 'mandatory', payload: {thinking: {type: 'adaptive'}, output_config: {effort: 'low'}}});
        expect(apply('claude-messages', services.claude, 'claude-opus-5-5', true).payload)
            .toMatchObject({thinking: {type: 'adaptive'}});
        expect(apply('claude-messages', services.claude, 'claude-sonnet-5-5', false).payload)
            .toMatchObject({thinking: {type: 'between_tools'}});
        expect(apply('claude-messages', services.claude, 'claude-sonnet-5-5', true).payload)
            .toMatchObject({thinking: {type: 'adaptive'}});
        expect(apply('claude-messages', services.claude, 'claude-haiku-5-5', false).payload)
            .toMatchObject({thinking: {type: 'disabled'}});
        expect(apply('claude-messages', services.claude, 'claude-haiku-5-5', true).payload)
            .toMatchObject({thinking: {type: 'adaptive'}});
    });

    it('限制 GPT-6.1 Sol 的最低思考档，并支持 GPT-6 与豆包 2.1 的开关', () => {
        expect(apply('openai-chat', services.openai, 'gpt-6.1-sol', false))
            .toMatchObject({effect: 'minimum', payload: {reasoning_effort: 'low'}});
        for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-terra']) {
            expect(apply('openai-chat', services.openai, model, false).payload).toMatchObject({reasoning_effort: 'none'});
            expect(apply('openai-chat', services.openai, model, true).payload).toMatchObject({reasoning_effort: 'low'});
        }
        for (const model of ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-evolving']) {
            expect(apply('openai-chat', services.doubao, model, false).payload).toMatchObject({thinking: {type: 'disabled'}});
            expect(apply('openai-chat', services.doubao, model, true).payload).toMatchObject({thinking: {type: 'enabled'}});
        }
        expect(apply('openai-chat', services.doubao, 'doubao-seed-unknown', false))
            .toEqual({effect: 'unsupported', payload: {model: 'doubao-seed-unknown'}});
    });

    it('只给已确认的 OpenAI、OpenRouter 与 Kimi 模型添加兼容字段', () => {
        expect(apply('openai-chat', services.openai, 'gpt-6-astra', true).payload)
            .toMatchObject({reasoning_effort: 'low'});
        expect(apply('openai-chat', services.openai, 'gpt-6-astra', false))
            .toMatchObject({effect: 'minimum', payload: {reasoning_effort: 'low'}});
        expect(apply('openai-chat', services.openai, 'gpt-5.6-luna', true).payload)
            .toMatchObject({reasoning_effort: 'low'});
        expect(apply('openai-chat', services.azureOpenai, 'gpt-5.1', false).payload)
            .toMatchObject({reasoning_effort: 'none'});
        expect(apply('openai-chat', services.openai, 'gpt-5-mini', true).payload)
            .toMatchObject({reasoning_effort: 'low'});
        expect(apply('openai-chat', services.openai, 'gpt-5-nano', false))
            .toMatchObject({effect: 'minimum', payload: {reasoning_effort: 'minimal'}});
        expect(apply('openai-chat', services.openrouter, 'google/gemini-3.6-flash', true).payload)
            .toMatchObject({reasoning: {effort: 'medium'}});
        expect(apply('openai-chat', services.openrouter, 'google/gemini-3.5-flash', false))
            .toMatchObject({effect: 'minimum', payload: {reasoning: {effort: 'minimal'}}});
        expect(apply('openai-chat', services.moonshot, 'kimi-k2.5', true).payload)
            .toMatchObject({thinking: {type: 'enabled'}});
        expect(apply('openai-chat', services.moonshot, 'kimi-k2.6', false).payload)
            .toMatchObject({thinking: {type: 'disabled'}});
    });

    it('未知服务或模型保持请求体原样', () => {
        const payload = {model: 'unknown', messages: []};
        expect(apply('openai-chat', services.openrouter, 'openrouter/auto', false, payload))
            .toEqual({effect: 'unsupported', payload});
        expect(apply('openai-chat', services.openai, 'gpt-4.1', true, payload))
            .toEqual({effect: 'unsupported', payload});
        expect(apply('openai-chat', services.moonshot, 'kimi-k3', true, payload))
            .toEqual({effect: 'unsupported', payload});
        expect(apply('openai-chat', 'custom:1', 'private-model', true, payload))
            .toEqual({effect: 'unsupported', payload});
    });
});

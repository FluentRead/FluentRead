import {describe, expect, it} from 'vitest';
import {createCompositeTranslationRoutingState} from '@/src/services/translation/compositeRouting';
import type {CompositeTranslationProvider} from '@/src/core/config/compositeTranslation';

const profile = (strategy: CompositeTranslationProvider['strategy']): CompositeTranslationProvider => ({
    id: 'composite:sample', name: '组合', strategy, services: ['google', 'microsoft', 'deepL'], timeoutMs: 12_000,
});

describe('composite routing observations', () => {
    it('preserves the configured order when a future strategy is not recognized', () => {
        const state = createCompositeTranslationRoutingState();
        const configured = {...profile('sequential'), strategy:'future-strategy' as never};
        expect(state.order(configured)).toEqual(configured.services);
    });
    it('rotates each request through list order and shuffles random members without mutating configuration', () => {
        const state = createCompositeTranslationRoutingState({random: () => 0});
        const sequential = profile('sequential');
        expect(state.order(sequential)).toEqual(sequential.services);
        expect(state.order(sequential)).toEqual(['microsoft', 'deepL', 'google']);
        expect(state.order(sequential)).toEqual(['deepL', 'google', 'microsoft']);
        expect(state.order(sequential)).toEqual(sequential.services);
        expect(state.order(profile('random'))).toEqual(['microsoft', 'deepL', 'google']);
        expect(sequential.services).toEqual(['google', 'microsoft', 'deepL']);
        expect(state.order({...sequential, strategy: 'random', services: []})).toEqual([]);
    });

    it('isolates round-robin groups and resets when members change or another strategy runs', () => {
        const state = createCompositeTranslationRoutingState({random: () => 0});
        const sequential = profile('sequential');
        expect(state.order(sequential)).toEqual(sequential.services);
        expect(state.order({...sequential, id: 'composite:other'})).toEqual(sequential.services);
        expect(state.order({...sequential, services: ['deepL', 'google']})).toEqual(['deepL', 'google']);
        expect(state.order({...sequential, services: ['deepL', 'google']})).toEqual(['google', 'deepL']);
        expect(state.order(sequential)).toEqual(sequential.services);
        state.order({...sequential, strategy: 'random'});
        expect(state.order(sequential)).toEqual(sequential.services);
        expect(state.order({...sequential, services: []})).toEqual([]);
        expect(state.order(sequential)).toEqual(sequential.services);
        expect(state.order({...sequential, services: ['google']})).toEqual(['google']);
        expect(state.order({...sequential, services: ['google']})).toEqual(['google']);
    });

    it('bounds round-robin groups without changing the saved member list', () => {
        const state = createCompositeTranslationRoutingState();
        const sequential = profile('sequential');
        state.order(sequential);
        for (let index = 0; index < 201; index += 1) state.order({...sequential, id: `composite:${index}`});
        expect(state.order(sequential)).toEqual(sequential.services);
    });

    it('learns speed and success, cools failures, and keeps observations isolated by group', () => {
        let time = 0;
        const state = createCompositeTranslationRoutingState({now: () => time});
        const smart = profile('smart');
        expect(state.order(smart)).toEqual(smart.services);
        state.record(smart.id, 'google', true, 200);
        state.record(smart.id, 'microsoft', true, 100);
        expect(state.order(smart)[0]).toBe('microsoft');
        state.record(smart.id, 'microsoft', false, 100);
        expect(state.order(smart)[0]).toBe('google');
        expect(state.order({...smart, id: 'composite:other'})).toEqual(smart.services);
        time = 30_001;
        expect(state.order(smart)[0]).toBe('microsoft');
        state.record(smart.id, 'microsoft', true, 150);
        expect(state.order(smart)[0]).toBe('microsoft');
    });

    it('bounds health entries and handles zero or nonfinite duration', () => {
        const state = createCompositeTranslationRoutingState();
        const smart = profile('smart');
        state.record(smart.id, 'google', false, Number.NaN);
        state.record(smart.id, 'microsoft', true, 0);
        expect(state.order(smart)[0]).toBe('microsoft');
        for (let index = 0; index < 201; index += 1) state.record(`composite:${index}`, 'google', true, 100);
        expect(state.order(smart)).toEqual(smart.services);
    });
});

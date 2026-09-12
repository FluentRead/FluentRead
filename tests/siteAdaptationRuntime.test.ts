import {beforeEach, describe, expect, it, vi} from 'vitest';

const effects = vi.hoisted(() => ({events: [] as string[]}));
vi.mock('@/src/core/site-adaptation/catalog', () => ({builtinSiteRulePack: {version: 1, rules: [{
    id: 'docs', name: 'Docs', match: {hosts: ['example.test'], paths: ['/docs/*']}, content: [{css: ['p']}],
}]}}));
vi.mock('@/src/core/translation/current', () => ({
    setCurrentTranslationAdapters: () => effects.events.push('apply'),
    setCurrentTranslationSidebarRegions: (enabled: boolean) => effects.events.push(`sidebar:${enabled}`),
}));
vi.mock('@/src/core/translation/text', () => ({
    setMinimumTranslationTextLength: (value: unknown) => {
        const length = Math.min(100, Math.max(1, Math.round(Number(value) || 2)));
        effects.events.push(`min:${length}`);
        return length;
    },
}));
vi.mock('@/src/features/full-page-translation/public', () => ({restoreOriginalContent: () => effects.events.push('restore')}));
vi.mock('@/src/app/translation/client', () => ({cancelAllTranslations: () => effects.events.push('cancel')}));
vi.mock('@/src/services/translation/context', () => ({resetPageTranslationContextCache: () => effects.events.push('reset-context')}));

import {applyCoreTranslationPreferences, createContentSiteAdaptationRuntime} from '@/src/app/content/siteAdaptationRuntime';
import type {Config} from '@/src/core/config/model';

function preferences(overrides: Partial<Config>): Config {
    return overrides as Config;
}

beforeEach(() => { effects.events = []; });

describe('content site adaptation composition', () => {
    it('initializes before content activation and clears old translations before publishing changes', () => {
        const session = createContentSiteAdaptationRuntime(undefined, new URL('https://example.test/docs/start'));
        expect(effects.events).toEqual(['apply']);
        expect(session.routeChanged(new URL('https://example.test/docs/next'))).toBe(false);
        session.update({enabled: false});
        expect(effects.events).toEqual(['apply', 'restore', 'cancel', 'reset-context', 'apply']);
        expect(session.routeChanged(new URL('https://example.test/settings'))).toBe(false);
    });

    it('publishes paragraph length and sidebar scope to the shared core, reporting only real changes', () => {
        expect(applyCoreTranslationPreferences(preferences({minTranslationTextLength: 4, sidebarTranslationEnabled: true}))).toBe(true);
        expect(effects.events).toEqual(['min:4', 'sidebar:true']);
        effects.events = [];
        expect(applyCoreTranslationPreferences(preferences({minTranslationTextLength: 4, sidebarTranslationEnabled: true}))).toBe(false);
        expect(effects.events).toEqual(['min:4', 'sidebar:true']);
        expect(applyCoreTranslationPreferences(preferences({minTranslationTextLength: 4}))).toBe(true);
        expect(applyCoreTranslationPreferences(preferences({minTranslationTextLength: 9}))).toBe(true);
    });

    it('restores on route boundary changes and delegates child-frame cleanup exactly once', () => {
        const session = createContentSiteAdaptationRuntime(undefined, new URL('https://example.test/docs/start'));
        expect(session.routeChanged(new URL('https://example.test/settings'))).toBe(true);
        expect(effects.events).toEqual(['apply', 'restore', 'cancel', 'reset-context']);
        effects.events = [];
        const child = createContentSiteAdaptationRuntime(undefined, new URL('https://example.test/docs/start'), () => effects.events.push('suspend-frame'));
        child.update({enabled: false});
        expect(effects.events).toEqual(['apply', 'suspend-frame', 'apply']);
    });
});

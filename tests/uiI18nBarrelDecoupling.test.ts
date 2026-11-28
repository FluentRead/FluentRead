/**
 * @file tests/uiI18nBarrelDecoupling.test.ts
 * 文件职责：验证 src/ui/i18n 门面解耦后 useUiI18n 与 localizeServiceOptions 的独立行为和回退契约。
 * 主要内容：覆盖纯独立回退上下文（含服务标签命中与普通旧文案回退）、外部回退工厂注册与缓存重置、Vue provide/inject 优先级，以及 localizeServiceOptions 的单条/批量/重复 ID/组合服务分支。
 * 模块边界：直接导入 src/ui/i18n/useUiI18n 与 src/ui/i18n/localizeServiceOptions，不引入或 mock 配置 store。
 */

import {createRenderer, h, ref} from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {registerUiLanguageBundle} from '@/src/core/i18n';
import {localizeServiceOptions} from '@/src/ui/i18n/localizeServiceOptions';
import {
    registerUiI18nFallbackFactory,
    UI_I18N_KEY,
    useUiI18n,
} from '@/src/ui/i18n/useUiI18n';
import type {UiI18nContext} from '@/src/ui/i18n/types';

afterEach(() => {
    registerUiI18nFallbackFactory(null);
});

describe('useUiI18n decoupled fallback and injection boundaries', () => {
    it('provides a working standalone fallback context without loading config store', async () => {
        registerUiI18nFallbackFactory(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const first = useUiI18n();
            const second = useUiI18n();
            expect(second).toBe(first);
            expect(first.language.value).toBe('zh-CN');
            expect(first.bundleRevision.value).toBe(0);
            expect(first.t('popup.donationTitle')).toBeTruthy();
            expect(first.translateLegacy('免费翻译服务')).toBe('免费翻译服务');
            expect(first.translateLegacy('未登记普通文案')).toBe('未登记普通文案');
            await expect(first.setLanguage('en-US')).resolves.toBe(false);
            expect(first.dispose()).toBeUndefined();
        } finally {
            warn.mockRestore();
        }
    });

    it('uses registered fallback factory when provided, disposes replaced fallback, and prefers Vue injected context', () => {
        const disposeSpy = vi.fn();
        const factoryContext: UiI18nContext = {
            language: ref('en-US'),
            bundleRevision: ref(1),
            t: (key) => `factory:${key}`,
            translateLegacy: (value) => `factory:${value}`,
            setLanguage: async () => true,
            dispose: disposeSpy,
        };
        const factory = vi.fn(() => factoryContext);
        registerUiI18nFallbackFactory(factory);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(useUiI18n()).toBe(factoryContext);
            expect(useUiI18n()).toBe(factoryContext);
            expect(factory).toHaveBeenCalledTimes(1);
            registerUiI18nFallbackFactory(null);
            expect(disposeSpy).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }

        const injectedContext: UiI18nContext = {
            language: ref('ja-JP'),
            bundleRevision: ref(2),
            t: (key) => `injected:${key}`,
            translateLegacy: (value) => `injected:${value}`,
            setLanguage: async () => true,
            dispose: () => undefined,
        };
        let observed: UiI18nContext | undefined;
        const renderer = createRenderer<Record<string, never>, Record<string, never>>({
            patchProp: () => undefined,
            insert: () => undefined,
            remove: () => undefined,
            createElement: () => ({}),
            createText: () => ({}),
            createComment: () => ({}),
            setText: () => undefined,
            setElementText: () => undefined,
            parentNode: () => null,
            nextSibling: () => null,
        });
        const app = renderer.createApp({
            setup() {
                observed = useUiI18n();
                return () => h('div');
            },
        });
        app.provide(UI_I18N_KEY, injectedContext);
        app.mount({});
        expect(observed).toBe(injectedContext);
        app.unmount();
    });

    it('covers service label override and legacy fallback inside standalone context', () => {
        registerUiLanguageBundle('en-US', {
            messages: {},
            legacyText: {'普通文案': 'Plain Copy'},
            legacyPatterns: {early: [], late: []},
        });
        registerUiI18nFallbackFactory(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const ctx = useUiI18n();
            // zh-CN returns undefined from translateServiceLabel and falls back to translateLegacyText.
            expect(ctx.translateLegacy('微软翻译')).toBe('微软翻译');
            expect(ctx.translateLegacy('普通文案')).toBe('普通文案');
        } finally {
            warn.mockRestore();
        }
    });
});

describe('localizeServiceOptions pure helper branches', () => {
    it('handles single-item, multi-item, duplicate profiles, endpoints, models, and composite profiles', () => {
        const translate = (value: string) => `tr:${value}`;
        // Single option (no Map index) with matching profile having endpoint & models
        expect(localizeServiceOptions(
            [{value: 'custom:a', label: 'A', description: 'desc', searchTerms: ['tag']}],
            [{id: 'custom:a', name: 'Custom A', endpoint: 'https://a.test', models: ['m1']}],
            translate,
        )).toEqual([
            {
                value: 'custom:a',
                label: 'Custom A',
                description: 'tr:desc',
                searchTerms: ['tag', 'A', 'Custom A', 'https://a.test', 'm1'],
            },
        ]);

        // Multi-option & multi-profile (Map index path) with duplicate ID, composite services, missing endpoint/models/description
        const result = localizeServiceOptions(
            [
                {value: 'dup', label: 'Dup1'},
                {value: 'comp', label: 'Comp', description: 'ignored'},
                {value: 'dup', label: 'Dup2', description: 'kept'},
                {value: 'missing', label: 'Missing'},
            ],
            [
                {id: 'other', name: 'Other'},
                {id: 'dup', endpoint: 'https://first.test'},
                {id: 'dup', endpoint: 'https://second.test'},
                {id: 'comp', name: 'My Composite', services: ['google', 'microsoft']},
            ],
            translate,
        );
        expect(result).toEqual([
            {value: 'dup', label: 'tr:Dup1', description: undefined, searchTerms: ['Dup1', 'tr:Dup1', 'https://first.test']},
            {value: 'comp', label: 'My Composite', description: undefined, searchTerms: ['Comp', 'My Composite']},
            {value: 'dup', label: 'tr:Dup2', description: 'tr:kept', searchTerms: ['Dup2', 'tr:Dup2', 'https://first.test']},
            {value: 'missing', label: 'tr:Missing', description: undefined, searchTerms: ['Missing', 'tr:Missing']},
        ]);
    });
});

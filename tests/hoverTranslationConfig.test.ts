/**
 * @file tests/hoverTranslationConfig.test.ts
 * 文件职责：验证悬浮待触发任务的配置归属边界，防止设置同步后仍使用旧请求或范围。
 * 主要内容：覆盖有效语言、服务、模型、术语、手势与展示变更，区分无关界面/凭据/其他服务设置和同值回声，并确认语义相同的词库改名不撤销任务。
 * 模块边界：只执行组合根的配置适配器，不模拟鼠标、真实存储或翻译供应商。
 */
import {describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {createQuickTranslationProfile} from '@/src/core/config/quickTranslation';
import {createHoverTranslationConfigInvalidator, createHoverTranslationConfigSubscription} from '@/src/app/content/hoverTranslationConfig';

describe('hover pending config ownership', () => {
    it('shares the gesture subscription cleanup and notifies after invalidating changed requests', () => {
        const source = new Config();
        const unsubscribe = vi.fn();
        let listener!: (next: Config) => void;
        const subscribe = vi.fn((next: typeof listener) => {listener = next; return unsubscribe;});
        const cancel = vi.fn();
        const onChange = vi.fn(() => expect(cancel).toHaveBeenCalledOnce());
        const stop = createHoverTranslationConfigSubscription(source, subscribe, cancel)(onChange);
        expect(subscribe).toHaveBeenCalledOnce();
        source.to = 'en';
        listener(source);
        expect(onChange).toHaveBeenCalledOnce();
        stop();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
    it.each([
        ['target', (source: Config) => {source.to = 'en';}],
        ['source', (source: Config) => {source.from = 'en';}],
        ['excluded languages', (source: Config) => {source.excludedLanguages = ['en'];}],
        ['excluded tags', (source: Config) => {source.excludedTags = ['blockquote'];}],
        ['service', (source: Config) => {source.hoverTranslationService = 'google';}],
        ['model', (source: Config) => {source.model[source.service] = 'changed-model';}],
        ['scope', (source: Config) => {source.translationScope = 'all';}],
        ['minimum length', (source: Config) => {source.minTranslationTextLength += 1;}],
        ['sidebar', (source: Config) => {source.sidebarTranslationEnabled = true;}],
        ['shortcut', (source: Config) => {source.hotkey = 'Shift';}],
        ['delay', (source: Config) => {source.mouseHoverTranslationDelay += 20;}],
        ['disabled', (source: Config) => {source.on = false;}],
        ['display', (source: Config) => {source.translationBeforeOriginal = true;}],
        ['thinking', (source: Config) => {source.model[source.service] = 'model'; source.modelThinking = {[source.service]: {model: true}};}],
    ])('cancels once after %s changes, with no repeated cancellation on echoes', (_name, change) => {
        const source = new Config();
        const cancel = vi.fn();
        const sync = createHoverTranslationConfigInvalidator(source, cancel);
        sync(source);
        expect(cancel).not.toHaveBeenCalled();
        change(source);
        sync(source);
        expect(cancel).toHaveBeenCalledOnce();
        sync({...source});
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('cancels a released quick-hover request when its profile changes, but keeps identical echoes', () => {
        const source = new Config();
        source.quickTranslationProfiles = [{...createQuickTranslationProfile('hover'), enabled: true, hotkey: 'Ctrl+T'}];
        const cancel = vi.fn();
        const sync = createHoverTranslationConfigInvalidator(source, cancel);
        source.quickTranslationProfiles = source.quickTranslationProfiles.map(profile => ({...profile}));
        sync(source);
        expect(cancel).not.toHaveBeenCalled();
        source.quickTranslationProfiles[0].enabled = false;
        sync(source);
        expect(cancel).toHaveBeenCalledOnce();
        sync(source);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it.each(['service', 'model', 'thinking', 'native batching'] as const)('invalidates inherited quick-hover %s independently of the main hover service', field => {
        const source = new Config(); source.hoverTranslationService = 'microsoft'; source.service = 'openai';
        source.model.openai = 'old-model';
        source.quickTranslationProfiles = [
            {...createQuickTranslationProfile('hover'), enabled: true, service: '', model: ''},
            {...createQuickTranslationProfile('hover'), enabled: false},
            {...createQuickTranslationProfile('full-page'), enabled: true},
        ];
        const cancel = vi.fn(), sync = createHoverTranslationConfigInvalidator(source, cancel);
        if (field === 'service') source.service = 'deepseek';
        if (field === 'model') source.model.openai = 'new-model';
        if (field === 'thinking') source.modelThinking = {openai: {'old-model': true}};
        if (field === 'native batching') source.nativeBatchTranslationEnabled.openai = false;
        sync(source); expect(cancel).toHaveBeenCalledOnce();
        sync({...source}); expect(cancel).toHaveBeenCalledOnce();
    });
    it('tracks a quick-hover explicit model while ignoring changes to another selected default model', () => {
        const source = new Config(); source.hoverTranslationService = 'microsoft';
        source.quickTranslationProfiles = [{...createQuickTranslationProfile('hover'), enabled: true, service: 'deepseek', model: 'fixed-model'}];
        const cancel = vi.fn(), sync = createHoverTranslationConfigInvalidator(source, cancel);
        source.model.deepseek = 'unrelated-default'; sync(source); expect(cancel).not.toHaveBeenCalled();
        source.modelThinking = {deepseek: {'fixed-model': true}}; sync(source); expect(cancel).toHaveBeenCalledOnce();
    });

    it('keeps pending hover work when the full-page multi-segment preference or budgets change', () => {
        const source = new Config();
        const cancel = vi.fn();
        const sync = createHoverTranslationConfigInvalidator(source, cancel);
        source.enableAIMultiSegment = true;
        sync(source);
        source.enableAIMultiSegment = false;
        sync(source);
        source.aiMultiSegmentMaxSegments = 32;
        sync(source);
        source.aiMultiSegmentMaxCharacters = 12_000;
        sync(source);
        expect(cancel).not.toHaveBeenCalled();
    });

    it('keeps pending work for UI updates, credentials and an unrelated service model', () => {
        const source = new Config();
        source.hoverTranslationService = 'microsoft';
        const cancel = vi.fn();
        const sync = createHoverTranslationConfigInvalidator(source, cancel);
        source.uiLanguage = 'en-US';
        source.model.google = 'irrelevant-model';
        source.service = 'google';
        source.token.google = 'fixture-only';
        sync(source);
        expect(cancel).not.toHaveBeenCalled();
        source.hoverTranslationService = '';
        sync(source);
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('invalidates changed glossary entries, but keeps cosmetic library updates', () => {
        const source = new Config();
        source.glossaryEnabled = true;
        source.glossaryLibraries = [{
            id: 'fixture', name: 'Terms', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh', domains: [],
            entries: [{id: 'term', source: 'hover', target: '悬浮', caseSensitive: false}],
        }];
        const cancel = vi.fn();
        const sync = createHoverTranslationConfigInvalidator(source, cancel);
        source.glossaryLibraries[0].name = 'Renamed';
        sync(source);
        expect(cancel).not.toHaveBeenCalled();
        source.glossaryLibraries[0].entries[0].target = '悬停';
        sync(source);
        expect(cancel).toHaveBeenCalledOnce();
    });
});

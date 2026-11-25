import {describe, expect, it} from 'vitest';

import {customModelString, services} from '@/src/core/config/catalog';
import {
    createQuickTranslationProfile,
    enabledQuickTranslationProfiles,
    findEnabledQuickTranslationHotkeyConflict,
    inputBoxTranslationTriggerHotkey,
    normalizeQuickTranslationProfiles,
    quickTranslationActionKey,
    type QuickTranslationProfile,
} from '@/src/core/config/quickTranslation';
import {resolveQuickTranslationInvocation} from '@/src/features/quick-translation/core';

function profile(overrides: Partial<QuickTranslationProfile> = {}): QuickTranslationProfile {
    return {
        id: 'quick-1',
        enabled: true,
        action: 'full-page',
        hotkey: 'Ctrl+T',
        service: '',
        model: '',
        targetLanguage: '',
        displayMode: 'inherit',
        fullPageMode: 'inherit',
        ...overrides,
    };
}

describe('快捷翻译调用解析', () => {
    it('损坏导入项不接管快捷键，不支持的服务和非模型服务不保留模型覆盖', () => {
        const result = normalizeQuickTranslationProfiles([
            null, [], {action: 'invalid'},
            profile({id: '', hotkey: 'F5', service: 'removed', model: 'obsolete'}),
            profile({id: 'kept', hotkey: 'F6', service: services.google, model: 'unused', displayMode: 'translation-only', fullPageMode: 'viewport'}),
            profile({id: 'kept', hotkey: 'F7', service: services.openai, model: 'chosen', displayMode: 'bilingual', fullPageMode: 'all'}),
            profile({id: 'empty', hotkey: ''}),
            profile({id: 'duplicate', action: 'hover', hotkey: 'F7', targetLanguage: 'fr'}),
        ], {isSupportedService: service => service !== 'removed', serviceUsesModel: service => service === services.openai});
        expect(result).toHaveLength(5);
        expect(result[0]).toMatchObject({enabled: false, service: '', model: ''});
        expect(result[1]).toMatchObject({enabled: true, service: services.google, model: '', displayMode: 'translation-only', fullPageMode: 'viewport'});
        expect(result[2]).toMatchObject({enabled: true, service: services.openai, model: 'chosen', displayMode: 'bilingual', fullPageMode: 'all'});
        expect(result[3]).toMatchObject({enabled: false, hotkey: ''});
        expect(result[4]).toMatchObject({enabled: false, action: 'hover', hotkey: '', targetLanguage: 'fr'});
        expect(new Set(result.map(item => item.id)).size).toBe(5);
    });
    it('快捷方案保留简繁目标差异，历史别名与非中文目标均可继续使用', () => {
        const normalized = normalizeQuickTranslationProfiles([
            profile({id: 'simplified', hotkey: 'Alt+S', targetLanguage: ' zh-CN '}),
            profile({id: 'traditional', hotkey: 'Alt+T', targetLanguage: 'zh-HK'}),
            profile({id: 'explicit-script', hotkey: 'Alt+X', targetLanguage: 'zh-Hans-TW'}),
            profile({id: 'custom', hotkey: 'Alt+C', targetLanguage: ' en-US '}),
            profile({id: 'inherit', hotkey: 'Alt+I', targetLanguage: ''}),
        ], {isSupportedService: () => true, serviceUsesModel: () => false});
        expect(normalized.map(item => item.targetLanguage)).toEqual([
            'zh-Hans', 'zh-Hant', 'zh-Hans', 'en-US', '',
        ]);
        const config = {service: services.openai, model: {}, customModel: {}, to: 'zh-Hans', display: 1,
            fullPageTranslationMode: 'viewport' as const, translationScope: 'content' as const};
        expect(resolveQuickTranslationInvocation(normalized[1]!, config).targetLanguage).toBe('zh-Hant');
        expect(resolveQuickTranslationInvocation(normalized[4]!, {...config, to: 'zh-Hant'}).targetLanguage).toBe('zh-Hant');
    });

    it('快捷方案冻结术语选择并区分跟随默认和显式关闭', () => {
        const config = {service: services.openai, model: {}, customModel: {}, to: 'zh-Hans', display: 1,
            fullPageTranslationMode: 'viewport' as const, translationScope: 'content' as const};
        const ids = ['technical'];
        const invocation = resolveQuickTranslationInvocation(profile({glossaryIds: ids}), config);
        ids.push('later');
        expect(invocation.glossaryIds).toEqual(['technical']);
        expect(resolveQuickTranslationInvocation(profile({glossaryIds: []}), config).glossaryIds).toEqual([]);
        expect(resolveQuickTranslationInvocation(profile({glossaryIds: null}), config).glossaryIds).toBeNull();
    });
    it('创建方案时生成无碰撞 ID，运行时只暴露已启用且已设置热键的匹配动作', () => {
        const created = createQuickTranslationProfile('hover', [
            {id: 'quick-1'},
            {id: 'quick-3'},
        ]);
        expect(created).toEqual({
            id: 'quick-2',
            enabled: false,
            action: 'hover',
            hotkey: '',
            service: '',
            model: '',
            targetLanguage: '',
            displayMode: 'inherit',
            fullPageMode: 'inherit',
        });

        const hover = profile({id: 'hover', action: 'hover', hotkey: 'Ctrl+T'});
        const page = profile({id: 'page', action: 'full-page', hotkey: 'Ctrl+Y'});
        const disabled = profile({id: 'disabled', enabled: false, hotkey: 'Alt+T'});
        const incomplete = profile({id: 'incomplete', hotkey: ''});
        expect(enabledQuickTranslationProfiles([hover, page, disabled, incomplete], 'hover'))
            .toEqual([hover]);
        expect(enabledQuickTranslationProfiles([hover, page, disabled, incomplete]))
            .toEqual([hover, page]);
        expect(findEnabledQuickTranslationHotkeyConflict([hover, page, disabled], 'Control+T')).toBe(hover);
        expect(findEnabledQuickTranslationHotkeyConflict([hover, page, disabled], 'Alt+T')).toBeUndefined();
        expect(findEnabledQuickTranslationHotkeyConflict([hover, page, disabled], 'Control')).toBeUndefined();
    });

    it('纯归一化入口处理缺省上下文、非字符串 ID 与保留热键', () => {
        const normalized = normalizeQuickTranslationProfiles([{
            id: 12, enabled: true, action: 'hover', hotkey: 'Ctrl+T', service: '',
        }], {
            isSupportedService: () => true,
            serviceUsesModel: () => false,
        });
        expect(normalized[0]).toMatchObject({id: 'quick-1', enabled: true, hotkey: 'Ctrl+T'});
    });

    it('输入框触发方式映射到首击占用键，未知值不产生保留项', () => {
        expect(inputBoxTranslationTriggerHotkey('ctrl_enter')).toBe('Ctrl+Enter');
        expect(inputBoxTranslationTriggerHotkey('triple_space')).toBe('Space');
        expect(inputBoxTranslationTriggerHotkey('triple_equal')).toBe('=');
        expect(inputBoxTranslationTriggerHotkey('triple_dash')).toBe('-');
        expect(inputBoxTranslationTriggerHotkey('custom', 'Option+Enter')).toBe('Alt+Enter');
        expect(inputBoxTranslationTriggerHotkey('custom', 'F9')).toBe('F9');
        expect(inputBoxTranslationTriggerHotkey('custom', 'Space')).toBe('');
        expect(inputBoxTranslationTriggerHotkey('custom')).toBe('');
        expect(inputBoxTranslationTriggerHotkey('disabled')).toBe('');
        expect(inputBoxTranslationTriggerHotkey(null)).toBe('');
    });

    it('只有显式布尔 true 才能启用导入方案，畸形 enabled 值全部安全关闭', () => {
        const normalized = normalizeQuickTranslationProfiles([
            {id: 'true', enabled: true, action: 'hover', hotkey: 'F5'},
            {id: 'string', enabled: 'false', action: 'hover', hotkey: 'F6'},
            {id: 'zero', enabled: 0, action: 'hover', hotkey: 'F7'},
            {id: 'null', enabled: null, action: 'hover', hotkey: 'F8'},
            {id: 'missing', action: 'full-page', hotkey: 'F9'},
        ], {
            isSupportedService: () => true,
            serviceUsesModel: () => false,
        });

        expect(normalized.map(({enabled}) => enabled)).toEqual([true, false, false, false, false]);
    });

    it('跟随默认时冻结当前服务、自定义模型、语言与范围，显示方式交给入口继承', () => {
        const invocation = resolveQuickTranslationInvocation(profile(), {
            service: services.openai,
            model: {[services.openai]: customModelString},
            customModel: {[services.openai]: 'private-default-model'},
            to: 'zh-Hans',
            display: 1,
            fullPageTranslationMode: 'viewport',
            translationScope: 'content',
        });

        expect(invocation).toEqual({
            profileId: 'quick-1',
            scope: 'content',
            service: services.openai,
            model: 'private-default-model',
            targetLanguage: 'zh-Hans',
            fullPageMode: 'viewport',
        });
        expect(invocation).not.toHaveProperty('displayMode');
    });

    it('显式方案会同时覆盖服务、模型、语言、展示和全文范围', () => {
        const invocation = resolveQuickTranslationInvocation(profile({
            hotkey: 'Ctrl+Y',
            service: services.deepseek,
            model: 'quick-deepseek-model',
            targetLanguage: 'ja',
            displayMode: 'translation-only',
            fullPageMode: 'all',
        }), {
            service: services.openai,
            model: {[services.openai]: 'global-model'},
            customModel: {},
            to: 'zh-Hans',
            display: 1,
            fullPageTranslationMode: 'viewport',
            translationScope: 'content',
        });

        expect(invocation).toEqual({
            profileId: 'quick-1',
            scope: 'content',
            service: services.deepseek,
            model: 'quick-deepseek-model',
            targetLanguage: 'ja',
            displayMode: 'single',
            fullPageMode: 'all',
        });
    });

    it('悬停方案可独立指定服务、模型、语言与展示，但不注入全文范围', () => {
        const invocation = resolveQuickTranslationInvocation(profile({
            action: 'hover',
            service: services.deepseek,
            model: 'hover-deepseek-model',
            targetLanguage: 'fr',
            displayMode: 'bilingual',
            fullPageMode: 'all',
        }), {
            service: services.openai,
            model: {[services.openai]: 'global-model'},
            customModel: {},
            to: 'en',
            display: 0,
            fullPageTranslationMode: 'all',
            translationScope: 'content',
        });

        expect(invocation).toEqual({
            profileId: 'quick-1',
            scope: 'content',
            service: services.deepseek,
            model: 'hover-deepseek-model',
            targetLanguage: 'fr',
            displayMode: 'bilingual',
        });
        expect(invocation).not.toHaveProperty('fullPageMode');
    });

    it('机器翻译且默认仅译文时省略模型与显示覆盖，保留继承语义', () => {
        expect(resolveQuickTranslationInvocation(profile({service: services.microsoft}), {
            service: services.openai,
            model: {},
            customModel: {},
            to: 'de',
            display: 0,
            fullPageTranslationMode: 'all',
            translationScope: 'content',
        })).toEqual({
            profileId: 'quick-1',
            scope: 'content',
            service: services.microsoft,
            targetLanguage: 'de',
            fullPageMode: 'all',
        });
    });

    it.each(['hover', 'section', 'full-page'] as const)('%s 跟随默认不把当前全局模式固化为显式覆盖', action => {
        const config = {service: services.microsoft, model: {}, customModel: {}, to: 'zh-Hans', display: 1,
            fullPageTranslationMode: 'viewport' as const, translationScope: 'content' as const};
        const selected = profile({action});
        const initial = resolveQuickTranslationInvocation(selected, config);
        config.display = 0;
        const switched = resolveQuickTranslationInvocation(selected, config);
        expect(initial).not.toHaveProperty('displayMode');
        expect(switched).toEqual(initial);
        expect(resolveQuickTranslationInvocation({...selected, displayMode: 'bilingual'}, config).displayMode).toBe('bilingual');
        expect(resolveQuickTranslationInvocation({...selected, displayMode: 'translation-only'}, config).displayMode).toBe('single');
    });

    it('悬浮与全文方案均冻结保存的全部节点设置，并独立保留视口范围', () => {
        const config = {
            service: services.microsoft, model: {}, customModel: {}, to: 'zh', display: 1,
            fullPageTranslationMode: 'viewport' as const, translationScope: 'all' as 'content' | 'all',
        };
        const hover = resolveQuickTranslationInvocation(profile({action: 'hover'}), config);
        const fullPage = resolveQuickTranslationInvocation(profile(), config);
        config.translationScope = 'content';
        expect(hover.scope).toBe('all');
        expect(hover).not.toHaveProperty('fullPageMode');
        expect(fullPage).toMatchObject({scope: 'all', fullPageMode: 'viewport'});
        expect(resolveQuickTranslationInvocation(profile(), config).scope).toBe('content');
    });

    it.each(['inherit', 'translation-only', 'bilingual'] as const)('Google 的 %s 方案只在当次执行时限制为双语，不覆盖保存偏好', displayMode => {
        const selected = profile({
            service: services.google,
            displayMode,
        });
        expect(resolveQuickTranslationInvocation(selected, {
            service: services.openai,
            model: {},
            customModel: {},
            to: 'de',
            display: 0,
            fullPageTranslationMode: 'viewport',
            translationScope: 'content',
        })).toMatchObject({
            service: services.google,
            displayMode: 'bilingual',
        });
        expect(selected.displayMode).toBe(displayMode);
    });
});


it('局部方案独立计数、去重并保存请求设置，不继承全文范围', () => {
    const normalized = normalizeQuickTranslationProfiles([
        ...Array.from({length: 9}, (_, index) => profile({id: `section-${index}`, action: 'section', hotkey: `F${index + 1}`, fullPageMode: 'all'})),
        profile({id: 'page', action: 'full-page', hotkey: 'F10'}),
        profile({id: 'hover', action: 'hover', hotkey: 'F11'}),
    ], {isSupportedService: () => true, serviceUsesModel: () => true});
    expect(normalized.filter(item => item.action === 'section')).toHaveLength(8);
    expect(normalized).toHaveLength(10);
    expect(normalized.filter(item => item.action === 'section').every(item => item.fullPageMode === 'inherit')).toBe(true);
    expect(quickTranslationActionKey('section')).toBe('section');
    expect(quickTranslationActionKey('hover')).toBe('hover');
    expect(quickTranslationActionKey('full-page')).toBe('fullPage');
});

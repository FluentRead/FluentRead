import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {
        on: true,
        service: 'plain',
        model: {} as Record<string, string>,
        customModel: {} as Record<string, string>,
        display: 1,
        translationOnlyDomains: [] as string[],
    },
    sendErrorMessage: vi.fn(),
}));

vi.mock('@/src/core/config/catalog', () => ({
    customModelString: 'custom-model',
    services: {google: 'google'},
    servicesType: {isUseModel: (service: string) => service.startsWith('ai-')},
}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/features/page-notice/public', () => ({sendErrorMessage: mocks.sendErrorMessage}));

import {checkConfig} from '@/src/features/full-page-translation/content/configCheck';
import {resolveTranslationPreflight} from '@/src/core/config/translationPreflight';
import {getFullPageTranslationDiagnostic, notifyFullPageTranslationState} from '@/src/features/full-page-translation/content/stateNotification';

describe('translation configuration guard', () => {
    beforeEach(() => {
        mocks.config.on = true;
        mocks.config.service = 'plain';
        mocks.config.model = {};
        mocks.config.customModel = {};
        mocks.config.display = 1;
        mocks.config.translationOnlyDomains = [];
        mocks.sendErrorMessage.mockReset();
        notifyFullPageTranslationState(false);
    });

    it('插件关闭时直接停止且不显示误导提示', () => {
        mocks.config.on = false;

        expect(checkConfig()).toBe(false);
        expect(mocks.sendErrorMessage).not.toHaveBeenCalled();
    });

    it('AI 服务缺少模型时给出可执行提示', () => {
        mocks.config.service = 'ai-demo';

        expect(checkConfig()).toBe(false);
        expect(mocks.sendErrorMessage).toHaveBeenCalledWith('模型尚未配置，请前往设置页配置');
    });

    it('自定义模型为空时同样拒绝请求', () => {
        mocks.config.service = 'ai-demo';
        mocks.config.model['ai-demo'] = 'custom-model';
        mocks.config.customModel['ai-demo'] = '';

        expect(checkConfig()).toBe(false);

        mocks.config.customModel['ai-demo'] = 'saved-custom-model';
        expect(checkConfig()).toBe(true);
    });

    it('谷歌翻译在仅译文模式下拒绝并说明原因', () => {
        mocks.config.service = 'google';
        mocks.config.display = 0;

        expect(checkConfig()).toBe(false);
        expect(mocks.sendErrorMessage).toHaveBeenCalledWith('「谷歌翻译」仅支持双语模式，请切换翻译服务');
    });

    it.each([
        {savedDisplay: 0, displayMode: undefined, expected: {allowed: false, reason: 'unsupported-display'}},
        {savedDisplay: 1, displayMode: undefined, expected: {allowed: true}},
        {savedDisplay: 0, displayMode: 'bilingual', expected: {allowed: true}},
        {savedDisplay: 1, displayMode: 'single', expected: {allowed: false, reason: 'unsupported-display'}},
    ] as const)('纯预检按保存模式 $savedDisplay 和本次覆盖 $displayMode 判断谷歌支持范围', ({savedDisplay, displayMode, expected}) => {
        mocks.config.service = 'google';
        mocks.config.display = savedDisplay;

        expect(resolveTranslationPreflight(mocks.config, displayMode ? {displayMode} : undefined)).toEqual(expected);
        expect(mocks.config.display).toBe(savedDisplay);
        expect(mocks.sendErrorMessage).not.toHaveBeenCalled();
    });

    it('网站仅译文在请求前执行相同服务限制，显式单次显示方案仍优先', () => {
        vi.stubGlobal('location', {href: 'https://docs.example.com/a'});
        try {
            mocks.config.translationOnlyDomains = ['example.com']; mocks.config.service = 'google';
            expect(checkConfig()).toBe(false);
            expect(checkConfig({displayMode: 'bilingual'})).toBe(true);
            mocks.config.service = 'plain'; expect(checkConfig()).toBe(true);
            expect(mocks.config.display).toBe(1);
        } finally {vi.unstubAllGlobals();}
    });

    it('快捷方案按本次服务、模型和显示方式校验，不被全局默认值误拦截', () => {
        mocks.config.service = 'ai-default';
        mocks.config.display = 0;

        expect(checkConfig({service: 'plain', displayMode: 'bilingual'})).toBe(true);
        expect(checkConfig({service: 'ai-profile', model: 'profile-model'})).toBe(true);
        expect(checkConfig({service: 'ai-profile'})).toBe(false);

        mocks.config.service = 'plain';
        mocks.config.display = 1;
        expect(checkConfig({service: 'google', displayMode: 'single'})).toBe(false);
        expect(checkConfig({service: 'google', displayMode: 'bilingual'})).toBe(true);
    });

    it('有效配置通过', () => {
        mocks.config.service = 'ai-demo';
        mocks.config.model['ai-demo'] = 'model-1';

        expect(checkConfig()).toBe(true);
    });
    it('仅显式全文入口记录模型和显示配置拒绝，关闭时清除，不把悬浮错误写入全文状态', () => {
        mocks.config.service = 'ai-demo';
        expect(checkConfig()).toBe(false); expect(getFullPageTranslationDiagnostic()).toBeUndefined();
        expect(checkConfig({}, true)).toBe(false);
        expect(getFullPageTranslationDiagnostic()?.code).toBe('model-configuration');
        mocks.config.service = 'google'; mocks.config.display = 0;
        expect(checkConfig({}, true)).toBe(false);
        expect(getFullPageTranslationDiagnostic()?.code).toBe('configuration');
        mocks.config.on = false;
        expect(checkConfig({}, true)).toBe(false); expect(getFullPageTranslationDiagnostic()).toBeUndefined();
    });
});

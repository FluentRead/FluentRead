import {beforeEach, describe, expect, it, vi} from 'vitest';
import {claimPointerSelectionSession} from '@/src/shared/dom/pointerSelectionSession';
import {services} from '@/src/core/config/catalog';
import type {Config} from '@/src/core/config/model';
import type {QuickTranslationProfile} from '@/src/core/config/quickTranslation';

const mocks = vi.hoisted(() => ({
    mountedDependencies: null as Record<string, any> | null,
    autoTranslateEnglishPage: vi.fn(),
    cancelPendingHoverTranslation: vi.fn(),
    handleTranslation: vi.fn(),
    isFullPageTranslationActive: vi.fn(() => false),
    getFullPageTranslationSessionId: vi.fn<() => number | undefined>(() => 1),
    restoreOriginalContent: vi.fn(),
    startSectionTranslationPicker: vi.fn(),
    serviceAvailable: vi.fn(),
}));
vi.mock('@/src/services/translation/capabilities', () => ({isTranslationServiceAvailable: mocks.serviceAvailable}));

vi.mock('@/src/features/quick-translation/public', () => ({
    mountQuickTranslationContentFeature: (deps: Record<string, any>) => {
        mocks.mountedDependencies = deps;
    },
}));
vi.mock('@/src/features/full-page-translation/public', () => ({
    autoTranslateEnglishPage: mocks.autoTranslateEnglishPage,
    cancelPendingHoverTranslation: mocks.cancelPendingHoverTranslation,
    handleTranslation: mocks.handleTranslation,
    isFullPageTranslationActive: mocks.isFullPageTranslationActive,
    getFullPageTranslationSessionId: mocks.getFullPageTranslationSessionId,
    restoreOriginalContent: mocks.restoreOriginalContent,
}));

vi.mock('@/src/features/section-translation/public', () => ({startSectionTranslationPicker: mocks.startSectionTranslationPicker}));

import {mountConfiguredQuickTranslation} from '@/src/app/content/quickTranslationRuntime';

function profile(overrides: Partial<QuickTranslationProfile> = {}): QuickTranslationProfile {
    return {
        id: 'quick-1',
        enabled: true,
        action: 'hover',
        hotkey: 'Ctrl+T',
        service: services.openai,
        model: 'quick-model',
        targetLanguage: 'ja',
        displayMode: 'translation-only',
        fullPageMode: 'inherit',
        ...overrides,
    };
}

function config(): Config {
    return {
        service: services.microsoft,
        model: {[services.microsoft]: ''},
        customModel: {},
        to: 'zh-Hans',
        display: 1,
        fullPageTranslationMode: 'viewport',
        translationScope: 'content',
        customSelectionTranslatorHotkey: '',
    } as Config;
}

describe('快捷翻译 content composition', () => {
    it('额外悬停或全文方案实际执行前取消未确认指针选择，局部入口保留自身切换语义', () => {
        mountConfiguredQuickTranslation(config(), {} as any, () => false, new AbortController().signal);
        const cancel = vi.fn();
        const release = claimPointerSelectionSession(cancel);
        mocks.mountedDependencies!.runSection(profile({action: 'section'}));
        expect(cancel).not.toHaveBeenCalled();
        mocks.mountedDependencies!.runHover(profile(), 12, 34);
        expect(cancel).toHaveBeenCalledOnce();
        release();
        const cancelNext = vi.fn();
        const releaseNext = claimPointerSelectionSession(cancelNext);
        mocks.mountedDependencies!.runFullPage(profile({action: 'full-page'}));
        expect(cancelNext).toHaveBeenCalledOnce();
        releaseNext();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mountedDependencies = null;
        mocks.isFullPageTranslationActive.mockReturnValue(false);
        mocks.getFullPageTranslationSessionId.mockReturnValue(1);
        vi.stubGlobal('document', {addEventListener: vi.fn()});
        vi.stubGlobal('window', {});
    });

    it('外部全文生命周期解除旧方案身份，默认手势回调和服务可用性跟随当前配置', () => {
        const current = config();
        mountConfiguredQuickTranslation(current, {} as any, () => false, new AbortController().signal);
        const dependencies = mocks.mountedDependencies!;
        expect(dependencies.resetLegacyKeyboardGestures()).toBeUndefined();
        mocks.serviceAvailable.mockReturnValueOnce(false).mockReturnValueOnce(true);
        expect(dependencies.isProfileAvailable(profile({service: ''}))).toBe(false);
        current.service = services.google;
        expect(dependencies.isProfileAvailable(profile({service: ''}))).toBe(true);
        expect(mocks.serviceAvailable.mock.calls).toEqual([[services.microsoft], [services.google]]);
        let active = false;
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.autoTranslateEnglishPage.mockImplementation(() => {active = true;return 1;});
        mocks.restoreOriginalContent.mockImplementation(() => {active = false;});
        const selected = profile({action: 'full-page'});
        dependencies.runFullPage(selected);
        for (const sessionId of [2, 3]) {
            mocks.getFullPageTranslationSessionId.mockReturnValue(sessionId);
            dependencies.runFullPage(selected);
        }
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledTimes(3);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(3);
    });

    it('宿主页面伪造全文生命周期事件不能改变快捷方案的恢复动作', () => {
        const pageDocument = new EventTarget();vi.stubGlobal('document', pageDocument);
        let active = false;
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.autoTranslateEnglishPage.mockImplementation(() => {active = true;pageDocument.dispatchEvent(new Event('fluentread-translation-started'));return 1;});
        mocks.restoreOriginalContent.mockImplementation(() => {active = false;pageDocument.dispatchEvent(new Event('fluentread-translation-ended'));});
        mountConfiguredQuickTranslation(config(), {} as any, () => false, new AbortController().signal);
        const selected = profile({action: 'full-page'}), deps = mocks.mountedDependencies!;
        deps.runFullPage(selected);
        pageDocument.dispatchEvent(new Event('fluentread-translation-started'));
        deps.runFullPage(selected);
        expect(active).toBe(false);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(2);
    });

    it('用会话身份区分外部会话和页面伪造事件', async () => {
        const lifecycle = await import('@/src/features/full-page-translation/content/stateNotification');
        const pageDocument = new EventTarget();vi.stubGlobal('document', pageDocument);
        let active = false, currentSession = 0;
        mocks.getFullPageTranslationSessionId.mockImplementation(() => active ? currentSession : undefined);
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.autoTranslateEnglishPage.mockImplementation(() => {active = true;const session = ++currentSession;lifecycle.notifyFullPageTranslationState(true);return session;});
        mocks.restoreOriginalContent.mockImplementation(() => {active = false;lifecycle.notifyFullPageTranslationState(false);});
        mountConfiguredQuickTranslation(config(), {} as any, () => false, new AbortController().signal);
        const selected = profile({action: 'full-page'}), deps = mocks.mountedDependencies!;
        deps.runFullPage(selected);
        pageDocument.dispatchEvent(new Event('fluentread-translation-ended'));
        deps.runFullPage(selected);
        expect(active).toBe(false);expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
        deps.runFullPage(selected);
        mocks.restoreOriginalContent();mocks.autoTranslateEnglishPage(); // 另一个入口建立新会话。
        deps.runFullPage(selected);
        expect(active).toBe(true);expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledTimes(4);
    });

    it('同步通知重入的外部会话不被标记成快捷方案的会话', async () => {
        const lifecycle = await import('@/src/features/full-page-translation/content/stateNotification');
        vi.stubGlobal('document', new EventTarget());
        let active = false, session = 0, externalStarts = 0, quickStarts = 0, armed = false;
        mocks.getFullPageTranslationSessionId.mockImplementation(() => active ? session : undefined);
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.autoTranslateEnglishPage.mockImplementation(() => {
            if (active) return undefined;
            active = true;const ownSession = ++session;quickStarts++;lifecycle.notifyFullPageTranslationState(true);
            return active && session === ownSession ? ownSession : undefined;
        });
        mocks.restoreOriginalContent.mockImplementation(() => {active = false;lifecycle.notifyFullPageTranslationState(false);});
        const unsubscribe = lifecycle.subscribeTranslationToolbarStatus(status => {
            if (status !== 'idle' || !armed) return;
            armed = false;active = true;session++;externalStarts++;lifecycle.notifyFullPageTranslationState(true);
        });
        try {
            mountConfiguredQuickTranslation(config(), {} as any, () => false, new AbortController().signal);
            const deps = mocks.mountedDependencies!, selected = profile({action: 'full-page'});
            armed = true;deps.runFullPage(selected);
            expect(externalStarts).toBe(1);expect(quickStarts).toBe(0);
            deps.runFullPage(selected);
            expect(active).toBe(true);expect(quickStarts).toBe(1);
        } finally {unsubscribe();mocks.restoreOriginalContent();}
    });

    it('启动通知期间被替换的会话不能被认作快捷方案', async () => {
        const lifecycle = await import('@/src/features/full-page-translation/content/stateNotification');
        vi.stubGlobal('document', new EventTarget());
        let active = false, session = 0, quickStarts = 0, armed = true;
        mocks.getFullPageTranslationSessionId.mockImplementation(() => active ? session : undefined);
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.restoreOriginalContent.mockImplementation(() => {active = false;lifecycle.notifyFullPageTranslationState(false);});
        mocks.autoTranslateEnglishPage.mockImplementation(() => {
            if (active) return undefined;
            active = true;const own = ++session;quickStarts++;lifecycle.notifyFullPageTranslationState(true);
            return active && session === own ? own : undefined;
        });
        const unsubscribe = lifecycle.subscribeTranslationToolbarStatus(status => {
            if (status !== 'translating' || !armed) return;
            armed = false;active = false;lifecycle.notifyFullPageTranslationState(false);
            active = true;session++;lifecycle.notifyFullPageTranslationState(true);
        });
        try {
            mountConfiguredQuickTranslation(config(), {} as any, () => false, new AbortController().signal);
            const deps = mocks.mountedDependencies!, selected = profile({action: 'full-page'});
            deps.runFullPage(selected);deps.runFullPage(selected);
            expect(quickStarts).toBe(2);expect(active).toBe(true);
        } finally {unsubscribe();mocks.restoreOriginalContent();}
    });

    it('把每条悬停方案解析为独立请求覆盖后交给共享翻译引擎', () => {
        const current = config();
        mountConfiguredQuickTranslation(current, {
            shouldReserveSelectionShortcut: vi.fn(),
            getConfiguredSelectionHotkey: vi.fn(() => 'none'),
            hasActiveSelectionTranslationCandidate: vi.fn(() => false),
        } as any, () => false, new AbortController().signal);

        const selected = profile();
        mocks.mountedDependencies!.runHover(selected, 12, 34, {delayMs: 80, continuous: true});

        expect(mocks.handleTranslation).toHaveBeenCalledWith(12, 34, {
            profileId: 'quick-1',
            scope: 'content',
            service: services.openai,
            model: 'quick-model',
            targetLanguage: 'ja',
            displayMode: 'single',
            delayMs: 80,
            continuous: true,
        });
        expect(mocks.mountedDependencies!.cancelPendingHoverTranslation)
            .toBe(mocks.cancelPendingHoverTranslation);
    });

    it('三种快捷入口传递默认显示继承语义，调整全局模式后同一全文方案仍恢复原文', () => {
        let active = false;
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.restoreOriginalContent.mockImplementation(() => {active = false;});
        mocks.autoTranslateEnglishPage.mockImplementation(() => {active = true;return 1;});
        const current = config();
        mountConfiguredQuickTranslation(current, {} as any, () => false, new AbortController().signal);
        const deps = mocks.mountedDependencies!, selected = profile({displayMode: 'inherit'});
        deps.runHover(selected, 12, 34);
        deps.runSection({...selected, action: 'section'});
        deps.runFullPage({...selected, action: 'full-page'});
        for (const invocation of [mocks.handleTranslation.mock.calls[0][2],
            mocks.startSectionTranslationPicker.mock.calls[0][0], mocks.autoTranslateEnglishPage.mock.calls[0][0]]) {
            expect(invocation).toMatchObject({service: services.openai, model: 'quick-model', targetLanguage: 'ja'});
            expect(invocation).not.toHaveProperty('displayMode');
        }
        current.display = 0;
        deps.runFullPage({...selected, action: 'full-page'});
        expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(2);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledOnce();
    });

    it('邮件 frame 转发解析后的全文方案，并保留本地悬停执行器', () => {
        const forward = vi.fn();
        mountConfiguredQuickTranslation(config(), {} as any, () => false, new AbortController().signal, vi.fn(), forward);
        const selected = profile({action: 'full-page', fullPageMode: 'all'});
        mocks.mountedDependencies!.runFullPage(selected);
        expect(forward).toHaveBeenCalledWith({profileId: 'quick-1', scope: 'content', service: services.openai,
            model: 'quick-model', targetLanguage: 'ja', displayMode: 'single', fullPageMode: 'all'});
        expect(mocks.cancelPendingHoverTranslation).toHaveBeenCalledOnce();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(mocks.restoreOriginalContent).not.toHaveBeenCalled();
    });

    it('全文方案按独立范围启动、切换另一方案，并用同一方案恢复原文', () => {
        let active = false;
        mocks.isFullPageTranslationActive.mockImplementation(() => active);
        mocks.restoreOriginalContent.mockImplementation(() => { active = false; });
        mocks.autoTranslateEnglishPage.mockImplementation(() => { active = true; return 1; });
        const current = config();
        mountConfiguredQuickTranslation(current, {
            shouldReserveSelectionShortcut: vi.fn(),
            getConfiguredSelectionHotkey: vi.fn(() => 'none'),
            hasActiveSelectionTranslationCandidate: vi.fn(() => false),
        } as any, () => false, new AbortController().signal);
        const selected = profile({action: 'full-page', hotkey: 'Ctrl+Y', fullPageMode: 'all'});
        const second = profile({id: 'quick-2', action: 'full-page', hotkey: 'Ctrl+U',
            model: 'second-model', fullPageMode: 'viewport'});

        mocks.mountedDependencies!.runFullPage(selected);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledWith({
            profileId: 'quick-1',
            scope: 'content',
            service: services.openai,
            model: 'quick-model',
            targetLanguage: 'ja',
            displayMode: 'single',
            fullPageMode: 'all',
        });
        expect(mocks.restoreOriginalContent).toHaveBeenCalledOnce();

        mocks.mountedDependencies!.runFullPage(second);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(2);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenLastCalledWith(expect.objectContaining({
            profileId: 'quick-2', model: 'second-model', fullPageMode: 'viewport',
        }));

        mocks.mountedDependencies!.runFullPage(second);
        expect(mocks.restoreOriginalContent).toHaveBeenCalledTimes(3);
        expect(mocks.autoTranslateEnglishPage).toHaveBeenCalledTimes(2);
    });

    it('局部方案把独立请求设置交给容器选择器，保持默认页面配置', () => {
        const current = config();
        const before = JSON.stringify(current);
        mountConfiguredQuickTranslation(current, {} as any, () => false, new AbortController().signal);
        mocks.mountedDependencies!.runSection(profile({action: 'section'}));
        expect(mocks.startSectionTranslationPicker).toHaveBeenCalledWith({
            profileId: 'quick-1', scope: 'content', service: services.openai,
            model: 'quick-model', targetLanguage: 'ja', displayMode: 'single',
        });
        expect(mocks.handleTranslation).not.toHaveBeenCalled();
        expect(mocks.autoTranslateEnglishPage).not.toHaveBeenCalled();
        expect(JSON.stringify(current)).toBe(before);
    });
});

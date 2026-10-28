import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {nextTick, watch} from 'vue';
import {parseHTML} from 'linkedom';

const store = vi.hoisted(() => {
    const listeners = new Set<(config: {uiLanguage?: string}) => void>();
    return {
        config: {uiLanguage: 'zh-CN'} as {uiLanguage?: string},
        listeners,
        requestConfigPatch: vi.fn(async () => undefined),
        emit(next: {uiLanguage?: string}) {
            Object.assign(this.config, next);
            for (const listener of listeners) listener(this.config);
        },
    };
});
const loader = vi.hoisted(() => ({ensure: vi.fn<(language: unknown) => Promise<boolean>>()}));

vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn()}}}));
vi.mock('@/src/services/config/store', () => ({
    config: store.config,
    configReady: Promise.resolve(),
    requestConfigPatch: store.requestConfigPatch,
    subscribeConfig: (listener: (config: {uiLanguage?: string}) => void) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
    },
}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: loader.ensure}));

import {registerUiLanguageBundle} from '@/src/core/i18n';
import {createUiI18nContext, createUiI18nPlugin} from '@/src/ui/i18n';

function deferred() {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    return {promise, resolve};
}

beforeEach(() => {
    store.config.uiLanguage = 'zh-CN';
    store.listeners.clear();
    store.requestConfigPatch.mockClear();
    loader.ensure.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('源语言界面的 DOM 扫描成本', () => {
    it('中文冷启动和动态更新不扫描，外语切回中文恢复一次后停止重复扫描', async () => {
        const {window} = parseHTML('<html><body><button title="设置">设置</button></body></html>');
        for (const key of ['document', 'Node', 'MutationObserver']) vi.stubGlobal(key, window[key as keyof typeof window]);
        vi.stubGlobal('NodeFilter', {SHOW_TEXT: 4});
        const walker = vi.spyOn(window.document, 'createTreeWalker');
        registerUiLanguageBundle('fr-FR', {messages: {}, legacyText: {'设置': 'Réglages'}, legacyPatterns: {early: [], late: []}});
        let unmount!: () => void;
        const app = {config: {globalProperties: {}}, provide: vi.fn(), directive: vi.fn(), mixin(hooks: {beforeUnmount: () => void}) { unmount = hooks.beforeUnmount; }};
        const plugin = createUiI18nPlugin({documentRoot: window.document.body});
        (plugin as {install: (value: unknown) => void}).install(app);
        const flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 15)); };
        try {
            await flush();
            window.document.body.appendChild(window.document.createElement('span')).textContent = '设置';
            await flush();
            expect(walker).not.toHaveBeenCalled();

            store.emit({uiLanguage: 'fr-FR'});
            await flush();
            expect(window.document.querySelector('button')?.textContent).toBe('Réglages');
            expect(window.document.querySelector('button')?.getAttribute('title')).toBe('Réglages');

            store.emit({uiLanguage: 'zh-CN'});
            await flush();
            expect(window.document.querySelector('button')?.textContent).toBe('设置');
            expect(window.document.querySelector('button')?.getAttribute('title')).toBe('设置');
            const scansAfterRestore = walker.mock.calls.length;
            window.document.querySelector('span')!.textContent = '新内容';
            await flush();
            expect(walker).toHaveBeenCalledTimes(scansAfterRestore);
        } finally {
            const root: {$root?: unknown} = {};
            root.$root = root;
            // 插件在根组件卸载时释放 document observer 和语言订阅。
            unmount.call(root);
        }
    });
});

describe('Vue 界面语言资源按需刷新', () => {
    it('资源到达后只为仍在使用该语言的界面递增修订号，普通配置变化不触发刷新', async () => {
        const pending = deferred();
        loader.ensure.mockReturnValue(pending.promise);
        const context = createUiI18nContext();
        await Promise.resolve();
        expect(loader.ensure).not.toHaveBeenCalled();

        store.emit({uiLanguage: 'ko-KR'});
        expect(context.language.value).toBe('ko-KR');
        expect(context.t('popup.donationTitle')).toBe(context.t('popup.donationTitle'));
        registerUiLanguageBundle('ko-KR', {messages: {'popup.donationTitle': '후원'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        pending.resolve(true);
        await pending.promise;
        await nextTick();
        expect(context.bundleRevision.value).toBe(1);
        expect(context.t('popup.donationTitle')).toBe('후원');

        // 已注册语言上的其他配置写入不应重复加载或整页重扫。
        store.emit({uiLanguage: 'ko-KR'});
        await Promise.resolve();
        expect(loader.ensure).toHaveBeenCalledOnce();
        expect(context.bundleRevision.value).toBe(1);
        context.dispose();
    });

    it('迟到或失败的资源不会刷新已切走或已销毁的界面', async () => {
        const stale = deferred();
        const failed = deferred();
        loader.ensure.mockReturnValueOnce(stale.promise).mockReturnValueOnce(failed.promise);
        const context = createUiI18nContext();
        store.emit({uiLanguage: 'ru-RU'});
        store.emit({uiLanguage: 'es-ES'});
        stale.resolve(true);
        failed.resolve(false);
        await Promise.all([stale.promise, failed.promise]);
        await nextTick();
        expect(context.bundleRevision.value).toBe(0);

        const late = deferred();
        loader.ensure.mockReturnValueOnce(late.promise);
        store.emit({uiLanguage: 'ja-JP'});
        context.dispose();
        late.resolve(true);
        await late.promise;
        expect(context.bundleRevision.value).toBe(0);
    });

    it('主动切换语言时先取得资源再提交配置，保存失败回滚到原语言', async () => {
        loader.ensure.mockResolvedValue(true);
        const context = createUiI18nContext();
        await context.setLanguage('fr-FR');
        expect(loader.ensure).toHaveBeenCalledWith('fr-FR');
        expect(loader.ensure.mock.invocationCallOrder[0]).toBeLessThan(store.requestConfigPatch.mock.invocationCallOrder[0]!);
        expect(store.requestConfigPatch).toHaveBeenCalledWith({uiLanguage: 'fr-FR', uiLanguageSetupCompleted: true}, expect.any(Function));
        expect(context.language.value).toBe('fr-FR');

        store.requestConfigPatch.mockRejectedValueOnce(new Error('offline'));
        await expect(context.setLanguage('en-US')).rejects.toThrow('offline');
        expect(context.language.value).toBe('fr-FR');
        context.dispose();
    });
});

    it('资源挂起时同语言的高频配置回声只订阅一次，资源到达仍刷新当前界面', async () => {
        const pending = deferred(); loader.ensure.mockReturnValue(pending.promise);
        const reactions = vi.spyOn(pending.promise, 'then');
        const context = createUiI18nContext();
        try {
            store.emit({uiLanguage: 'ja-JP'});
            for (let i = 0; i < 5000; i++) store.emit({uiLanguage: 'ja-JP'});
            await Promise.resolve();
            expect(loader.ensure).toHaveBeenCalledTimes(1);
            expect(reactions.mock.calls.length).toBeLessThanOrEqual(2);
            expect(context.language.value).toBe('ja-JP');
            registerUiLanguageBundle('ja-JP', {messages: {'popup.donationTitle': '寄付'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
            pending.resolve(true); await pending.promise; await nextTick();
            expect(context.bundleRevision.value).toBe(1); expect(context.t('popup.donationTitle')).toBe('寄付');
        } finally {context.dispose(); pending.resolve(false);}
    });


it('资源挂起时反复创建和卸载界面，不为每个旧上下文保留 Promise 回调', async () => {
    const pending = deferred(); loader.ensure.mockReturnValue(pending.promise);
    const reactions = vi.spyOn(pending.promise, 'then');
    const contexts: ReturnType<typeof createUiI18nContext>[] = [];
    try {
        for (let i = 0; i < 1000; i++) {
            store.config.uiLanguage = 'ru-RU';
            const context = createUiI18nContext(); contexts.push(context); context.dispose();
        }
        await Promise.resolve();
        expect(store.listeners.size).toBe(0);
        expect(loader.ensure).toHaveBeenCalledOnce();
        expect(reactions.mock.calls.length).toBeLessThanOrEqual(2);
        pending.resolve(false); await pending.promise; for (let i = 0; i < 4; i++) await Promise.resolve();
        expect(contexts.every(context => context.bundleRevision.value === 0)).toBe(true);
    } finally {for (const context of contexts) context.dispose(); pending.resolve(false);}
});

it('多个界面共享资源加载，卸载旧界面后仍刷新存活界面', async () => {
    const pending = deferred(); loader.ensure.mockReturnValue(pending.promise);
    store.config.uiLanguage = 'ru-RU';
    const first = createUiI18nContext(), second = createUiI18nContext();
    try {
        first.dispose(); pending.resolve(true); await pending.promise; await nextTick();
        expect(loader.ensure).toHaveBeenCalledOnce();
        expect(first.bundleRevision.value).toBe(0); expect(second.bundleRevision.value).toBe(1);
    } finally {first.dispose(); second.dispose(); pending.resolve(false);}
});

it('加载回调触发另一个界面卸载时，迟到订阅不能更新已卸载界面', async () => {
    const pending = deferred(); loader.ensure.mockReturnValue(pending.promise); store.config.uiLanguage = 'ru-RU';
    const first = createUiI18nContext(), second = createUiI18nContext();
    const stop = watch(first.bundleRevision, () => second.dispose(), {flush: 'sync'});
    try {
        pending.resolve(true); await pending.promise; await nextTick();
        expect(first.bundleRevision.value).toBe(1); expect(second.bundleRevision.value).toBe(0);
        expect(store.listeners.size).toBe(1);
    } finally {stop(); first.dispose(); second.dispose(); pending.resolve(false);}
});

it('一个界面的同步刷新抛错不会阻止其他界面收到资源', async () => {
    const pending = deferred(); loader.ensure.mockReturnValue(pending.promise); store.config.uiLanguage = 'ru-RU';
    const first = createUiI18nContext(), second = createUiI18nContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = watch(first.bundleRevision, () => {throw new Error('fixture watcher');}, {flush: 'sync'});
    try {
        pending.resolve(true); await pending.promise; await nextTick();
        expect(first.bundleRevision.value).toBe(1); expect(second.bundleRevision.value).toBe(1);
    } finally {stop(); first.dispose(); second.dispose(); pending.resolve(false); warn.mockRestore();}
});

it('同步创建加载任务失败后不残留共享条目，下一次仍能重试', async () => {
    loader.ensure.mockImplementationOnce(() => {throw new Error('controlled loader');}).mockResolvedValueOnce(false);
    store.config.uiLanguage = 'ru-RU';
    expect(() => createUiI18nContext()).toThrow('controlled loader');
    const retry = createUiI18nContext();
    try {expect(loader.ensure).toHaveBeenCalledTimes(2);}
    finally {retry.dispose();}
    await Promise.resolve();
});

it('加载异步拒绝后可由后续配置事件重试', async () => {
    const second = deferred();
    loader.ensure.mockImplementationOnce(() => Promise.reject(new Error('controlled loader'))).mockReturnValueOnce(second.promise);
    const context = createUiI18nContext();
    try {
        store.emit({uiLanguage: 'ru-RU'});
        for (let i = 0; i < 5; i++) await Promise.resolve();
        store.emit({uiLanguage: 'ru-RU'}); expect(loader.ensure).toHaveBeenCalledTimes(2);
    } finally {context.dispose(); second.resolve(false);}
});

it('失败后允许重试，旧失败不能删除新的语言请求', async () => {
    const first = deferred(), next = deferred();
    loader.ensure.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const context = createUiI18nContext();
    try {
        store.emit({uiLanguage: 'ru-RU'}); first.resolve(false);
        await first.promise; for (let i = 0; i < 4; i++) await Promise.resolve();
        store.emit({uiLanguage: 'ru-RU'}); expect(loader.ensure).toHaveBeenCalledTimes(2);
        store.emit({uiLanguage: 'ru-RU'}); expect(loader.ensure).toHaveBeenCalledTimes(2);
        context.dispose(); next.resolve(true); await next.promise; await nextTick();
        expect(context.bundleRevision.value).toBe(0);
    } finally {context.dispose(); first.resolve(false); next.resolve(false);}
});

it('不同语言请求各持一份回调，往返后只刷新当前语言', async () => {
    const russian = deferred(), spanish = deferred();
    loader.ensure.mockImplementation(language => language === 'ru-RU' ? russian.promise : spanish.promise);
    const ruReactions = vi.spyOn(russian.promise, 'then'), esReactions = vi.spyOn(spanish.promise, 'then');
    const context = createUiI18nContext();
    try {
        for (let i = 0; i < 1000; i++) {store.emit({uiLanguage: 'ru-RU'}); store.emit({uiLanguage: 'es-ES'});}
        store.emit({uiLanguage: 'ru-RU'}); await Promise.resolve();
        expect(loader.ensure).toHaveBeenCalledTimes(2);
        expect(ruReactions.mock.calls.length).toBeLessThanOrEqual(2); expect(esReactions.mock.calls.length).toBeLessThanOrEqual(2);
        registerUiLanguageBundle('ru-RU', {messages: {'popup.donationTitle': 'Поддержка'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        registerUiLanguageBundle('es-ES', {messages: {'popup.donationTitle': 'Apoyo'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        russian.resolve(true); spanish.resolve(true); await Promise.all([russian.promise, spanish.promise]); await nextTick();
        expect(context.bundleRevision.value).toBe(1); expect(context.t('popup.donationTitle')).toBe('Поддержка');
        store.emit({uiLanguage: 'es-ES'}); expect(context.t('popup.donationTitle')).toBe('Apoyo');
        expect(context.bundleRevision.value).toBe(1);
    } finally {context.dispose(); russian.resolve(false); spanish.resolve(false);}
});

it('另一界面先注册相同语言时，下一次配置回声刷新中文回退且迟到回执不重复刷新', async () => {
    const pending = deferred(); loader.ensure.mockReturnValue(pending.promise);
    const context = createUiI18nContext();
    try {
        store.emit({uiLanguage: 'en-US'});
        registerUiLanguageBundle('en-US', {messages: {'popup.donationTitle': 'Support'}, legacyText: {}, legacyPatterns: {early: [], late: []}});
        store.emit({uiLanguage: 'en-US'});
        expect(context.bundleRevision.value).toBe(1); expect(context.t('popup.donationTitle')).toBe('Support');
        pending.resolve(true); await pending.promise; await nextTick();
        expect(context.bundleRevision.value).toBe(1);
    } finally {context.dispose(); pending.resolve(false);}
});

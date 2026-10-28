/**
 * @file src/ui/i18n.ts
 *
 * 文件职责：把 core i18n 的纯翻译能力接入 Vue，并在每个扩展 UI runtime 中
 * 订阅共享配置、即时切换语言和安全迁移尚未 key 化的旧文案。
 * 主要内容：提供 createUiI18nPlugin、useUiI18n 和 v-ui-i18n 指令；语言切换时按需加载资源包，
 * 选择先取得可用资源，再以调用身份串行提交字段补丁；旧资源、旧失败和已销毁 runtime 不得回写新选择。
 * 资源到达后通过 bundleRevision 刷新渲染；服务目录使用 core 的本地文案覆盖，不更改脚本版已发布远程语言包。
 * 旧文案扫描由 i18n/legacyDom.ts 隔离，并且只作用于明确授权的 UI 子树；扫描权限与 document 元信息权限分离。
 * 元信息写入授权根所属 document，资源未就绪时标记实际中文回退语言；插件卸载或初始化失败时释放所拥有的资源。
 * 模块边界：这里负责 Vue 响应式和配置 patch，不定义语言文案；文案资源与纯
 * fallback 规则在 src/core/i18n，配置持久化仍由 services/config/store 负责。
 */

import {
    inject,
    readonly,
    ref,
    watch,
    type App,
    type InjectionKey,
    type Plugin,
} from 'vue';
import browser from 'webextension-polyfill';
import {
    config,
    configReady,
    requestConfigPatch,
    getConfigRevision,
    subscribeConfig,
} from '@/src/services/config/store';
import {
    DEFAULT_UI_LANGUAGE,
    hasUiLanguageBundle,
    normalizeUiLanguage,
    translate,
    translateLegacyText,
    type TranslationParams,
    type UiLanguage,
} from '@/src/core/i18n';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {translateServiceLabel} from '@/src/core/i18n/serviceLabels';
import {createUiI18nDirective, observeUiDocument} from './i18n/legacyDom';
import type {UiI18nContext} from './i18n/types';

export type {UiI18nContext} from './i18n/types';

interface LocalizableServiceOption {
    value: string;
    label: string;
    description?: string;
    searchTerms?: string[];
}

interface ServiceProfileSummary {
    id: string;
    name?: string;
    endpoint?: string;
    models?: string[];
    services?: string[];
}

/** 在 UI 边界复用本次标签译文；profile 按需索引且保留重复 ID 首项，原始名称仍用于搜索。 */
export function localizeServiceOptions<T extends LocalizableServiceOption>(
    options: readonly T[],
    profiles: readonly ServiceProfileSummary[],
    translateLegacy: (value: string) => string,
): Array<T & {searchTerms: string[]}> {
    // 单项查询沿用 find 的提前停止；批量查询只扫描未见过的前缀，不预扫整个目录。
    const profileIndex = options.length > 1 && profiles.length > 1
        ? new Map<string, ServiceProfileSummary>() : undefined;
    let profileCursor = 0;
    return options.map((option) => {
        let profile = profileIndex ? profileIndex.get(option.value) : profiles.find((item) => item.id === option.value);
        while (profileIndex && !profile && profileCursor < profiles.length) {
            const next = profiles[profileCursor++], id = next.id;
            if (!profileIndex.has(id)) profileIndex.set(id, next);
            if (id === option.value) profile = profileIndex.get(id);
        }
        const label = profile?.name || translateLegacy(option.label);
        return {
            ...option,
            label,
            description: profile?.services ? undefined : option.description ? translateLegacy(option.description) : option.description,
            searchTerms: [...(option.searchTerms || []), option.label, label, ...(profile ? [...(profile.endpoint ? [profile.endpoint] : []), ...(profile.models || [])] : [])],
        };
    });
}

export const UI_I18N_KEY: InjectionKey<UiI18nContext> = Symbol('fluentread-ui-i18n');

/** 每种语言的未完成加载只绑定一个 Promise 回调；卸载的界面可以移除自己的监听。 */
const pendingUiBundles = new Map<UiLanguage, {listeners: Set<(loaded: boolean) => void>}>();
function subscribePendingUiBundle(language: UiLanguage, listener: (loaded: boolean) => void): () => void {
    let owner = pendingUiBundles.get(language);
    if (!owner) {
        owner = {listeners: new Set()};
        pendingUiBundles.set(language, owner);
        const current = owner;
        const finish = (loaded: boolean) => {
            if (pendingUiBundles.get(language) !== current) return;
            pendingUiBundles.delete(language);
            const listeners = [...current.listeners];
            current.listeners.clear();
            for (const notify of listeners) {try {notify(loaded);} catch { /* 一个已失效界面不能阻止其他界面。 */ }}
        };
        try {void ensureUiLanguageBundle(language).then(finish, () => finish(false));}
        catch (error) {pendingUiBundles.delete(language); throw error;}
    }
    owner.listeners.add(listener);
    return () => {owner.listeners.delete(listener);};
}

export function createUiI18nContext(): UiI18nContext {
    const languageState = ref<UiLanguage>(normalizeUiLanguage(config.uiLanguage || DEFAULT_UI_LANGUAGE));
    const bundleRevisionState = ref(0);
    let disposed = false;
    const pendingBundleLoads = new Map<UiLanguage, () => void>();
    type LanguageChange = {
        language: UiLanguage;
        previousLanguage: UiLanguage;
        stage: 'loading' | 'queued' | 'persisting';
        invalidated: boolean;
        baseRevision?: number;
    };
    let currentChange: LanguageChange | undefined;
    let languageWriteQueue = Promise.resolve();
    const ownedWrites = new Set<LanguageChange>();

    const applyLanguage = (value: unknown): void => {
        if (disposed) return;
        const nextLanguage = normalizeUiLanguage(value);
        const sameLanguage = languageState.value === nextLanguage;
        languageState.value = nextLanguage;
        // 同一语言的挂起请求只附加一次回调；往返切换时仍由当前语言决定是否刷新。
        if (hasUiLanguageBundle(nextLanguage)) {
            // 另一个界面可能已注册资源，但本界面的原请求尚未回执。
            const stop = pendingBundleLoads.get(nextLanguage);
            if (stop) {
                pendingBundleLoads.delete(nextLanguage);
                stop();
                if (sameLanguage) bundleRevisionState.value += 1;
            }
            return;
        }
        if (pendingBundleLoads.has(nextLanguage)) return;
        const stop = subscribePendingUiBundle(nextLanguage, (loaded) => {
            pendingBundleLoads.delete(nextLanguage);
            if (loaded && !disposed && languageState.value === nextLanguage) bundleRevisionState.value += 1;
        });
        pendingBundleLoads.set(nextLanguage, stop);
    };

    applyLanguage(languageState.value);
    const applyConfigLanguage = (value: unknown): void => {
        if (disposed) return;
        const nextLanguage = normalizeUiLanguage(value);
        // store 在 requestConfigPatch 内同步发布乐观值，拒绝前可能发布权威回滚。
        // 同 revision 的原语言是自己的回滚；外部同值的新 revision 不能复活旧请求。
        const owner = [...ownedWrites].find(change => {
            if (nextLanguage === change.language) {
                change.baseRevision ??= getConfigRevision();
                return true;
            }
            return nextLanguage === change.previousLanguage && change.baseRevision !== undefined
                && getConfigRevision() === change.baseRevision;
        });
        if (!owner && nextLanguage !== languageState.value && currentChange) currentChange.invalidated = true;
        if (owner && currentChange && owner !== currentChange && !currentChange.invalidated
            && currentChange.stage !== 'loading') {
            currentChange.previousLanguage = nextLanguage;
            return;
        }
        applyLanguage(nextLanguage);
    };
    const unsubscribe = subscribeConfig(nextConfig => applyConfigLanguage(nextConfig.uiLanguage));
    void configReady.then(() => {
        applyConfigLanguage(config.uiLanguage);
    }).catch(() => undefined);

    const language = readonly(languageState);
    const bundleRevision = readonly(bundleRevisionState);
    const t = (key: string, params?: TranslationParams): string => {
        void bundleRevision.value;
        return translate(key, language.value, params);
    };
    const translateLegacy = (value: string): string => {
        void bundleRevision.value;
        return translateServiceLabel(value, language.value) ?? translateLegacyText(value, language.value);
    };

    async function setLanguage(value: unknown): Promise<boolean> {
        if (disposed) return false;
        const change: LanguageChange = {
            language: normalizeUiLanguage(value),
            previousLanguage: currentChange && !currentChange.invalidated && currentChange.stage === 'queued'
                ? currentChange.previousLanguage : languageState.value,
            stage: 'loading',
            invalidated: false,
        };
        currentChange = change;
        const current = () => !disposed && currentChange === change && !change.invalidated;
        try {
            // 先取得资源，再预览最新选择；等待前驱存储期间也不能显示旧提交的回声。
            const [loaded] = await Promise.all([ensureUiLanguageBundle(change.language), configReady]);
            if (!current()) return false;
            // 主动选择必须真正取得资源；失败留在原语言，由选择器显示本地化的重试反馈。
            if (!loaded) throw new Error('UI language resources are unavailable');
            change.stage = 'queued';
            applyLanguage(change.language);
            const predecessor = languageWriteQueue;
            const write = predecessor.then(async () => {
                if (!current()) return false;
                change.stage = 'persisting';
                ownedWrites.add(change);
                try {
                    await requestConfigPatch(
                        {uiLanguage: change.language, uiLanguageSetupCompleted: true},
                        browser.runtime.sendMessage.bind(browser.runtime),
                    );
                    return current();
                } catch (error) {
                    if (!current() || (change.baseRevision !== undefined
                        && getConfigRevision() !== change.baseRevision)) return false;
                    // 真实 store 通常已回读权威值；只在仍显示本次乐观值时恢复自己的前驱。
                    if (languageState.value === change.language) applyLanguage(change.previousLanguage);
                    throw error;
                } finally {
                    ownedWrites.delete(change);
                }
            });
            languageWriteQueue = write.then(() => undefined, () => undefined);
            return await write;
        } catch (error) {
            if (!current()) return false;
            throw error;
        } finally {
            if (currentChange === change) currentChange = undefined;
        }
    }

    return {
        language,
        bundleRevision,
        t,
        translateLegacy,
        setLanguage,
        dispose() {
            if (disposed) return;
            disposed = true;
            currentChange = undefined;
            for (const stop of pendingBundleLoads.values()) stop();
            pendingBundleLoads.clear();
            unsubscribe();
        },
    };
}

let fallbackContext: UiI18nContext | null = null;

export function useUiI18n(): UiI18nContext {
    const injected = inject(UI_I18N_KEY, null);
    if (injected) return injected;
    fallbackContext ??= createUiI18nContext();
    return fallbackContext;
}

export interface UiI18nPluginOptions {
    /** 仅用于扩展专属 document 页面；不要传入宿主网页的 body。 */
    documentRoot?: HTMLElement | null;
    /** 仅扫描调用方拥有的 UI 子树；undefined 沿用 documentRoot，null 禁止自动扫描。 */
    uiRoot?: HTMLElement | null;
    /** 扩展专属页面的标题资源 key；不传则只同步 html[lang]。 */
    documentTitleKey?: string;
}

export function createUiI18nPlugin(options: UiI18nPluginOptions = {}): Plugin {
    return {
        install(app: App) {
            const context = createUiI18nContext();
            const directive = createUiI18nDirective(context);
            const cleanup = [() => context.dispose(), () => directive.dispose()];
            let disposed = false;
            const dispose = (): void => {
                if (disposed) return;
                disposed = true;
                let firstError: unknown;
                let failed = false;
                for (const stop of cleanup) {
                    try { stop(); } catch (error) {
                        if (!failed) { failed = true; firstError = error; }
                    }
                }
                cleanup.length = 0;
                if (failed) throw firstError;
            };
            // Vue 的原生 unmount 在 mount 成功前不运行组件或 app 清理 hook。
            // 插件拥有的订阅和 observer 在入口先释放；根 mixin 共用同一个幂等清理。
            if (typeof app.unmount === 'function') {
                const unmount = app.unmount.bind(app);
                app.unmount = () => {
                    try { dispose(); } finally { unmount(); }
                };
            }
            const updateDocumentMetadata = (): void => {
                if (!options.documentRoot) return;
                const targetDocument = options.documentRoot.ownerDocument;
                // 资源加载中或失败时实际呈现中文，lang 必须与屏幕阅读器读到的回退文案一致。
                targetDocument.documentElement.lang = hasUiLanguageBundle(context.language.value)
                    ? context.language.value : DEFAULT_UI_LANGUAGE;
                if (options.documentTitleKey) {
                    targetDocument.title = context.t(options.documentTitleKey);
                }
            };
            try {
                const uiRoot = options.uiRoot === undefined ? options.documentRoot : options.uiRoot;
                if (uiRoot) cleanup.push(observeUiDocument(uiRoot, context));
                updateDocumentMetadata();
                cleanup.push(watch([context.language, context.bundleRevision], updateDocumentMetadata, {flush: 'post'}));
                app.provide(UI_I18N_KEY, context);
                app.config.globalProperties.$fluentT = context.t;
                app.directive('ui-i18n', directive);
                app.mixin({
                    beforeUnmount() {
                        if (this.$root === this) dispose();
                    },
                });
            } catch (error) {
                try { dispose(); } catch { /* 保留插件安装错误。 */ }
                throw error;
            }
        },
    };
}

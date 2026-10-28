import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {installShadowAndRouteBridge} from '@/src/platform/shadow-ui/pageBridge';
import {showPageNotice} from '@/src/features/page-notice/public';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import browser, {resetPlatformMessageHandler, setPlatformMessageHandler} from './browser';
import {restoreUserscriptIcon} from './iconData';
import {createUserscriptContentContext} from './context';
import {userscriptFetch} from './http';
import {ensureUserscriptConfig} from './initialize';
import {getUserscriptConfigCount} from './count';
import {getUserscriptFunction} from './api';
import {inflateGzipBase64} from './compression';
import {isUserscriptSettingsUrl} from './settingsPage';
import {waitForContentDocument} from '@/src/app/content/pageLifecycle';
import {
    completeUserscriptConfigPreparation,
    failUserscriptConfigPreparation,
} from './storage';

declare global {
    // 脚本管理器可能在 SPA 状态变化时重新注入，因此在当前沙箱中保存幂等启动标记。
    var __fluentReadUserscriptBootstrapped: boolean | undefined;
}

let disposeShadowAndRouteBridge: (() => void) | undefined;
let disposeUserscriptRuntime: (() => void) | undefined;
let pagehideListener: ((event: PageTransitionEvent) => void) | undefined;

async function waitForDocumentBody(): Promise<void> {
    if (document.readyState !== 'loading') return;
    await waitForContentDocument(document, new AbortController().signal);
}

function registerMenu(label: string, listener: () => void): void {
    const register = getUserscriptFunction('GM_registerMenuCommand', 'registerMenuCommand');
    if (typeof register === 'function') register(label, listener);
}

/**
 * 先安装页面路由桥和 GM 网络适配器，再归一化配置，最后动态加载共享内容应用。
 * 这个顺序可防止共享模块在 userscript 能力边界建立前读取扩展专属配置或使用原生 fetch。
 */
async function bootstrap(): Promise<void> {
    if (globalThis.__fluentReadUserscriptBootstrapped) return;
    globalThis.__fluentReadUserscriptBootstrapped = true;
    if (globalThis.__FLUENTREAD_ICON_DATA__) globalThis.__FLUENTREAD_ICON_DATA__ = restoreUserscriptIcon(globalThis.__FLUENTREAD_ICON_DATA__);

    // 独立设置标签页只挂载设置 UI；不把主世界桥或内容翻译装进底层网页。
    const settingsPage = __FLUENTREAD_FULL_OPTIONS__ && isUserscriptSettingsUrl(globalThis.location?.href || '');
    if (!settingsPage) disposeShadowAndRouteBridge = installShadowAndRouteBridge();
    setRuntimeFetch(userscriptFetch);
    try {
        if (globalThis.__fluentReadUserscriptCssCompressed) {
            globalThis.__fluentReadUserscriptCss = await inflateGzipBase64(globalThis.__fluentReadUserscriptCssCompressed);
        }
        await ensureUserscriptConfig();
        completeUserscriptConfigPreparation();
    } catch (error) {
        failUserscriptConfigPreparation(error);
        throw error;
    }

    // 配置边界就绪后再加载这些模块，避免模块级初始化观察到尚未迁移的旧配置。
    const [platformModule, settingsModule, contentModule, translationModule, configModule] = await Promise.all([
        __FLUENTREAD_FULL_OPTIONS__ ? import('./platformFull') : import('./platform'),
        __FLUENTREAD_FULL_OPTIONS__ ? import('./settingsFull') : import('./settings'),
        import('@/entrypoints/content'),
        import('@/src/app/content/features'),
        import('@/src/services/config/store'),
    ]);
    await configModule.configReady;
    const ctx = createUserscriptContentContext();
    const synchronizeCountProjection = async () => {
        const count = await getUserscriptConfigCount();
        if (configModule.config.count === count) return;
        configModule.config.count = count;
        await configModule.saveConfig(configModule.config);
    };
    const openSettings = (section?: string) => {
        // 在同步用户手势内先打开标签页，随后再同步计数。
        void settingsModule.openUserscriptSettings(ctx, section).catch((error) => {
            console.error('[FluentRead userscript] 打开设置页失败', error);
        });
        void synchronizeCountProjection()
            .catch((error) => console.error('[FluentRead userscript] 同步翻译计数失败', error));
    };
    const openSettingsEvent = () => openSettings();
    const closeSettings = () => settingsModule.closeUserscriptSettings();
    const synchronizeVisibleCount = () => {
        if (document.visibilityState === 'visible') {
            void synchronizeCountProjection().catch((error) => {
                console.error('[FluentRead userscript] 同步翻译计数失败', error);
            });
        }
    };
    const toggleTranslationListener = (
        message: any,
        _sender: unknown,
        sendResponse: (response?: unknown) => void,
    ) => {
        if (message?.type !== 'userscriptTogglePageTranslation') return false;
        if (translationModule.isFullPageTranslationActive()) translationModule.restoreOriginalContent();
        else void translationModule.autoTranslateEnglishPage();
        sendResponse({success: true});
        return true;
    };
    let runtimeDisposed = false;
    const disposeRuntime = (pageLeaving = false) => {
        if (runtimeDisposed) return;
        runtimeDisposed = true;
        const ownedPagehideListener = pagehideListener;
        pagehideListener = undefined;
        const cleanup = [
            () => window.removeEventListener('fluentread-userscript-open-settings', openSettingsEvent),
            () => window.removeEventListener('fluentread-userscript-close-settings', closeSettings),
            () => window.removeEventListener('focus', synchronizeVisibleCount),
            () => document.removeEventListener('visibilitychange', synchronizeVisibleCount),
            () => {if (ownedPagehideListener) window.removeEventListener('pagehide', ownedPagehideListener);},
            () => browser.runtime.onMessage.removeListener(toggleTranslationListener),
            () => {
                try {closeSettings();}
                catch (error) {console.error('[FluentRead userscript] 关闭设置面板失败', error);}
            },
            () => ctx.invalidate(),
        ];
        // pagehide 的计数 flush 可能还在等待 GM 存储；离页时保留同页消息处理器，
        // 直到脚本沙箱随文档销毁，避免把最后一批增量送进空适配器。
        if (!pageLeaving) cleanup.push(() => resetPlatformMessageHandler());
        let failed = false;
        let firstError: unknown;
        for (const stop of cleanup) {
            try {stop();} catch (error) {
                if (!failed) {failed = true; firstError = error;}
            }
        }
        if (failed) throw firstError;
    };
    disposeUserscriptRuntime = disposeRuntime;
    setPlatformMessageHandler(platformModule.createPlatformMessageHandler(openSettings));
    window.addEventListener('fluentread-userscript-open-settings', openSettingsEvent);
    window.addEventListener('fluentread-userscript-close-settings', closeSettings);
    window.addEventListener('focus', synchronizeVisibleCount);
    document.addEventListener('visibilitychange', synchronizeVisibleCount);

    if (!settingsPage) browser.runtime.onMessage.addListener(toggleTranslationListener);

    registerMenu('流畅阅读：打开设置', openSettings);
    if (!settingsPage) {
        registerMenu('流畅阅读：翻译 / 恢复当前网页', () => {
            if (translationModule.isFullPageTranslationActive()) translationModule.restoreOriginalContent();
            else void translationModule.autoTranslateEnglishPage();
        });
        let menuToggleRevision = 0;
        registerMenu('流畅阅读：启用 / 暂停', () => {
            const revision = ++menuToggleRevision;
            // 通过权威 patch 通知页面生命周期；不能把临时暂停写成各功能偏好。
            void configModule.requestConfigPatch({on: !configModule.config.on})
                .catch(() => {
                    if (revision !== menuToggleRevision || ctx.isInvalid) return;
                    console.error('[FluentRead userscript] 启停设置结果未确认，请检查设置。');
                    try {showPageNotice(translate('userscript.toggleUnconfirmed', normalizeUiLanguage(configModule.config.uiLanguage)), 'error', {key: 'userscript-toggle'});} catch { /* 页面通知不可用时保留固定诊断。 */ }
                });
        });
        registerMenu('流畅阅读：清空翻译缓存', () => {
            void browser.runtime.sendMessage({type: 'clearTranslationCache'});
        });
    }

    // 单页 userscript 没有扩展 content-script 的自动销毁钩子，离页时显式释放监听器和 Shadow UI。
    pagehideListener = (event) => {
        // BFCache 往返由共享 pageLifecycle 暂停/恢复；只有真正离页才销毁沙箱运行时。
        if (!event.isTrusted || event.persisted) return;
        disposeUserscriptRuntime = undefined;
        const disposeBridge = disposeShadowAndRouteBridge;
        disposeShadowAndRouteBridge = undefined;
        for (const stop of [() => disposeRuntime(true), disposeBridge]) {
            try {stop?.();}
            catch (error) {console.error('[FluentRead userscript] 离页清理失败', error);}
        }
    };
    window.addEventListener('pagehide', pagehideListener);

    await waitForDocumentBody();
    if (settingsPage) {
        openSettings();
        return;
    }

    await contentModule.default.main(ctx as never);
    void browser.runtime.sendMessage({type: 'userscriptCacheMaintenance'}).catch(() => undefined);
}

void bootstrap().catch((error) => {
    const cleanup = [disposeUserscriptRuntime, disposeShadowAndRouteBridge];
    disposeUserscriptRuntime = undefined;
    disposeShadowAndRouteBridge = undefined;
    for (const stop of cleanup) {
        try {stop?.();}
        catch (cleanupError) {console.error('[FluentRead userscript] 初始化清理失败', cleanupError);}
    }
    globalThis.__fluentReadUserscriptBootstrapped = false;
    console.error('[FluentRead userscript] 初始化失败', error);
});

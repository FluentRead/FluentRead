/**
 * @file src/app/sidepanel/index.ts
 * 文件职责：组装原生翻译侧边栏的 Vue 应用并拥有页面生命周期。
 * 主要内容：等待权威配置、最新语言和字体准备后挂载共享翻译 UI；页面退出时卸载应用，停止翻译并释放订阅，失败时提供可重试的本地化提示；缓存页面隐藏时由工作台停止请求并保留当前输入。
 * 模块边界：只负责页面装配，不保存原文或译文、不实现翻译协议；配置由共享 store 持有，比较请求和隐藏取消由 translation-center feature 持有。
 */
import {createApp, type App} from 'vue';
import SidepanelApp from './SidepanelApp.vue';
import './sidepanel.css';
import 'element-plus/es/components/base/style/css';
import '@/src/ui/styles/interface-skins.css';
import {config, configReady, getConfigHydrationStatus} from '@/src/services/config/store';
import {createUiI18nPlugin} from '@/src/ui/i18n';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {prepareInterfaceFont} from '@/src/ui/interfaceAppearance';
import {translate} from '@/src/core/i18n';

/** 页面退出撤销挂载资格；已挂载页面同步卸载，取消所属翻译请求。 */
export async function mountTranslationSidepanel(selector: string): Promise<void> {
    let exited = false;
    let app: App | undefined;
    const exit = () => {
        exited = true;
        window.removeEventListener('pagehide', exit);
        app?.unmount();
    };
    window.addEventListener('pagehide', exit);
    try {
        await configReady;
        if (exited) return;
        if (getConfigHydrationStatus() !== 'ready') throw new Error('Sidepanel configuration is not ready');
        let preparedLanguage: typeof config.uiLanguage | undefined;
        let preparedFont: typeof config.interfaceFont | undefined;
        do {
            const language = config.uiLanguage, font = config.interfaceFont;
            await Promise.all([
                language === preparedLanguage ? undefined : ensureUiLanguageBundle(language),
                font === preparedFont ? undefined : prepareInterfaceFont(font),
            ]);
            if (exited) return;
            if (getConfigHydrationStatus() !== 'ready') throw new Error('Sidepanel configuration is not ready');
            preparedLanguage = language;preparedFont = font;
        } while (preparedLanguage !== config.uiLanguage || preparedFont !== config.interfaceFont);
        app = createApp(SidepanelApp);
        app.use(createUiI18nPlugin({documentRoot: document.body, documentTitleKey: '翻译中心'}));
        app.onUnmount(() => window.removeEventListener('pagehide', exit));
        app.mount(selector);
    } catch (error) {
        if (exited) return;
        exit();
        console.error('[FluentRead] Sidepanel startup failed', error);
        const root = document.querySelector(selector)!;
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');message.textContent = translate('sidepanel.startupError', config.uiLanguage);
        const retry = document.createElement('button');
        retry.type = 'button';retry.textContent = translate('translationCenter.retry', config.uiLanguage);
        retry.addEventListener('click', () => window.location.reload());
        root.replaceChildren(message, retry);
    }
}

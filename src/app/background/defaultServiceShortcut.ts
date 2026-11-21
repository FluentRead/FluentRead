/**
 * @file src/app/background/defaultServiceShortcut.ts
 * 文件职责：响应浏览器分配给 FluentRead 的常用翻译服务循环快捷键。
 * 主要内容：按收藏顺序筛选当前页面可用且凭据齐全的服务，组合须有可用成员，通过配置修改队列切换默认项，再向触发时的文档反馈候选和当前项。
 * 模块边界：不发起翻译，不写入独立功能服务；浏览器命令、配置持久化和页面通知都复用既有端口。
 */
import {options, services} from '@/src/core/config/catalog';
import {styles} from '@/src/core/config/constants';
import {getCompositeTranslationProvider, isCompositeTranslationProviderId, withCompositeTranslationServiceOptions} from '@/src/core/config/compositeTranslation';
import {isTranslationServiceDisabled} from '@/src/core/config/serviceAvailability';
import {withCustomOpenAIServiceOptions} from '@/src/core/config/customOpenAI';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {isExtensionDisabledOnSite, resolveSiteTranslationDisplay} from '@/src/core/site-rules/domain';
import {config, configReady, requestConfigPatch} from '@/src/services/config/store';
import {isTranslationServiceAvailable} from '@/src/services/translation/capabilities';
import type {ContextMenuClickTab} from './contextMenuActions';
import type {ConfigMutationCoordinator} from './handlers/configPersistence';
import {isBrowserTabId, type TabTranslationStateStore} from './tabTranslationState';

export function installDefaultServiceShortcut(states: TabTranslationStateStore, mutations: ConfigMutationCoordinator): void {
    browser.commands?.onCommand?.addListener((command: string, activeTab?: ContextMenuClickTab) => {
        if (command !== 'cycle-favorite-translation-services') return;
        void (async () => {
            const tab = activeTab ?? (await browser.tabs.query({active: true, currentWindow: true}))[0];
            const url = tab?.url;
            if (!isBrowserTabId(tab?.id) || !url || !/^https?:\/\//iu.test(url)) return;
            const tabId = tab.id;
            const current = states.captureDocument(tabId);
            const result = await mutations.run(async () => {
                await configReady;
                if (!current() || !config.on || isExtensionDisabledOnSite(url, config.disabledExtensionDomains)) return null;
                const display = resolveSiteTranslationDisplay(config, url);
                const labels = new Map(withCompositeTranslationServiceOptions(
                    withCustomOpenAIServiceOptions(options.services, config.customOpenAIProviders),
                    config.compositeTranslationProviders).map(({value, label}) => [value, label]));
                const isEligible = (service: string) => labels.has(service)
                    && !isTranslationServiceDisabled(config.disabledTranslationServices, service)
                    && isTranslationServiceAvailable(service) && !getMissingCredentialMessage(service, config)
                    && (service !== services.google || display === styles.bilingualTranslation);
                const choices = config.favoriteServices.filter(service => isEligible(service)
                    && (!isCompositeTranslationProviderId(service)
                        || getCompositeTranslationProvider(config.compositeTranslationProviders, service)?.services
                            .some(member => !isCompositeTranslationProviderId(member) && isEligible(member))));
                if (choices.length === 0) return {choices: [], selectedIndex: -1};
                const selectedIndex = (choices.indexOf(config.service) + 1) % choices.length;
                const selected = choices[selectedIndex]!;
                if (selected !== config.service) await requestConfigPatch({service: selected});
                return {choices: choices.map(service => labels.get(service)!), selectedIndex};
            }).catch(error => {
                console.error('[FluentRead] 常用翻译服务快捷键切换失败', error);
                return {choices: [], selectedIndex: -1, failed: true};
            });
            if (result && current()) {
                await browser.tabs.sendMessage(tabId, {type: 'defaultServiceShortcutNotice', ...result}, {frameId: 0})
                    .catch(() => undefined);
            }
        })().catch(() => undefined);
    });
}

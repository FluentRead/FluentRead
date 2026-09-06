/**
 * @file src/app/background/writingRuntime.ts
 * 文件职责：将写作后台接入已有配置、模型用量与浏览器生命周期。
 * 主要内容：装配端口与服务；配置变更、网站停用、标签关闭或导航时取消生成。
 * 模块边界：只负责组合，不读取网页，不实现提示词和编辑器写回。
 */
import {isWritingPage} from '@/src/core/config/writing';
import browser from 'webextension-polyfill';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {createWritingHandler} from '@/src/features/writing-assistant/background';
import {createWritingRuntime} from '@/src/services/writing/runtime';
import {modelUsageRepository} from '@/src/platform/storage/modelUsageRepository';

export function installWritingBackgroundRuntime(): void {
    const handler = createWritingHandler({
        extensionId: browser.runtime.id, optionsUrl: browser.runtime.getURL('options.html'), ready: configReady,
        eligibility: sender => {
            if (!isWritingPage(sender.url || '')) return '写作助手仅支持 Gmail 和 GitHub 的 Issue、Pull Request 回复页面';
            if (!config.on || !config.writing.enabled) return '写作助手已停用';
            const domains = config.disabledExtensionDomains;
            if (isExtensionDisabledOnSite(sender.url!, domains) || isExtensionDisabledOnSite(sender.tab?.url || '', domains)) return '当前网站已禁用写作助手';
            return undefined;
        },
        run: (request, signal, progress) => {
            const generation = modelUsageRepository.captureGeneration();
            return createWritingRuntime(() => config, event => {
                void modelUsageRepository.recordMany([event], generation).catch(() => undefined);
            })(request, signal, progress);
        },
    });
    browser.runtime.onConnect.addListener(port => handler.connect(port));
    let previous = '';
    subscribeConfig(next => {
        const key = JSON.stringify([next.on, next.writing, next.disabledExtensionDomains, next.service, next.model, next.customModel, next.proxy, next.token]);
        if (key !== previous) handler.cancelAll();
        previous = key;
    });
    browser.tabs.onRemoved.addListener(tabId => handler.cancelTab(tabId));
    browser.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) handler.cancelTab(tabId); });
}

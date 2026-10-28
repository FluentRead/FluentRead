/**
 * @file src/app/background/writingRuntime.ts
 * 文件职责：将写作后台接入已有配置、模型用量与浏览器生命周期。
 * 主要内容：装配端口、服务和只读学习记忆，顶层页面使用浏览器提供的同源标签地址识别页内导航后的写作场景，子框架保留自身地址；按可信发送者隔离隐私窗口，配置变更、网站停用、标签关闭或导航时取消生成。
 * 模块边界：只负责组合，不读取网页，不实现提示词和编辑器写回。
 */
import {normalizeConfig, type Config} from '@/src/core/config/model';
import {isWritingPage} from '@/src/core/config/writing';
import browser from 'webextension-polyfill';
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {createWritingHandler, type WritingSender} from '@/src/features/writing-assistant/background';
import {createWritingRuntime} from '@/src/services/writing/runtime';
import {createLearningMemoryRecall} from '@/src/services/harness/memoryRecall';
import {learningMemoryRepository} from '@/src/platform/storage/learningMemoryRepository';
import {getModelUsageRepository} from '@/src/platform/storage/modelUsageRepository';
import {resolveWritingReadiness} from '@/src/core/config/writingReadiness';
import {getHarnessModelInputKey} from '@/src/services/harness/modelGateway';
import {toPublicConfig} from '@/src/services/config/history';
import {services} from '@/src/core/config/catalog';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {sha256Hex} from '@/src/shared/function/sha256';

function resolveWritingSenderUrl(sender: WritingSender): string {
    if (sender.frameId !== 0) return sender.url || '';
    try {
        // MessageSender.url 可能仍是内容脚本初次注入时的地址，标签地址才反映 GitHub 页内导航后的当前路由。
        const page = new URL(sender.tab?.url || '');
        return page.origin === new URL(sender.url || '').origin ? page.href : '';
    } catch { return ''; }
}

export function installWritingBackgroundRuntime(): () => void {
    const handler = createWritingHandler({
        extensionId: browser.runtime.id, optionsUrl: browser.runtime.getURL('options.html'), ready: configReady,
        eligibility: sender => {
            if (!isWritingPage(resolveWritingSenderUrl(sender))) return '写作助手仅支持 Gmail 邮件与 GitHub 新建 Issue、Issue/PR 回复页面';
            if (!config.on || !config.writing.enabled) return '写作助手已停用';
            const domains = [...config.disabledExtensionDomains, ...config.writing.disabledDomains];
            if (isExtensionDisabledOnSite(sender.url!, domains) || isExtensionDisabledOnSite(sender.tab?.url || '', domains)) return '当前网站已禁用写作助手';
            return undefined;
        },
        run: (request, signal, progress, sender) => {
            const generation = getModelUsageRepository().captureGeneration();
            return createWritingRuntime(() => config, event => {
                void getModelUsageRepository().recordMany([event], generation).catch(() => undefined);
            }, {recall: createLearningMemoryRecall(learningMemoryRepository)})(request, signal, progress, Boolean(sender.tab?.incognito || browser.extension.inIncognitoContext));
        },
    });
    browser.runtime.onConnect.addListener(port => handler.connect(port));
    const configurationKeys = (next: Config) => {
        const {service, model} = resolveWritingReadiness(next, false);
        const modelKey = getHarnessModelInputKey(next, service, model);
        return {
            general: JSON.stringify([next.on, next.to, next.harness.memoryEnabled,
                {...next.writing, service: undefined, model: undefined, referenceLanguage: undefined}, next.disabledExtensionDomains, modelKey]),
            // 忠实翻译使用请求内冻结的语言和草稿，不读取风格、记忆或全局目标等无关偏好。
            translation: JSON.stringify([next.on, next.writing.enabled, next.writing.disabledDomains, next.disabledExtensionDomains, modelKey]),
            // 面板会观察全部代理和自定义服务；摘要只用于本地检测，不能传给内容页。
            publicInputs: sha256Hex(JSON.stringify([service, model, next.proxy, next.customOpenAIProviders,
                service === services.deepseek && isModelThinkingEnabled(next.modelThinking, service, model),
                next.on, next.writing.enabled, next.writing.disabledDomains, next.disabledExtensionDomains])),
            target: next.to,
        };
    };
    const publicTranslationKey = (next: Config) => {
        const publicConfig = normalizeConfig(toPublicConfig(next));
        const {service, model} = resolveWritingReadiness(publicConfig, false);
        return JSON.stringify([publicConfig.on, publicConfig.writing.enabled, publicConfig.writing.disabledDomains,
            publicConfig.disabledExtensionDomains, getHarnessModelInputKey(publicConfig, service, model),
            service, model, publicConfig.proxy, publicConfig.token, publicConfig.customOpenAIProviders,
            service === services.deepseek && isModelThinkingEnabled(publicConfig.modelThinking, service, model)]);
    };
    let previous = configurationKeys(config);
    let previousPublic = publicTranslationKey(config);
    let revision = 0;
    subscribeConfig(next => {
        const current = configurationKeys(next);
        const prior = previous;
        previous = current;
        const ownerChanged = current.publicInputs !== prior.publicInputs;
        const changed = current.general !== prior.general;
        if (!changed && !ownerChanged) return;
        const owner = ++revision;
        const publicTranslation = publicTranslationKey(next);
        const priorPublic = previousPublic;
        previousPublic = publicTranslation;
        if (changed) {
            if (current.translation !== prior.translation) handler.cancelAll(undefined,
                publicTranslation === priorPublic ? () => owner === revision
                    && configurationKeys(config).translation === current.translation
                    && publicTranslationKey(config) === publicTranslation : undefined);
            else handler.cancelAll(request => request.intent !== 'translate' || (request.language === 'target' && current.target !== prior.target));
        }
    });
    browser.tabs.onRemoved.addListener(tabId => handler.cancelTab(tabId));
    browser.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) handler.cancelTab(tabId); });
    return () => handler.cancelAll();
}

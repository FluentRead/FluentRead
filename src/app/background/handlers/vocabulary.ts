/**
 * @file src/app/background/handlers/vocabulary.ts
 * 文件职责：集中暴露生词本后台用例、变更广播协议和仓库契约，供 messageRuntime 组装跨标签页同步能力。
 * 主要内容：重导出词书 handler 与广播器，组装本地材料仓库、来源权限、站点门控和无正文变更通知。
 * 模块边界：这里仅选择浏览器、配置和仓库依赖，不实现持久化事务或词条规则；业务 handler 位于 vocabulary feature。
 */
export {
    createBrowserVocabularyBookChangedBroadcaster,
    createVocabularyBackgroundHandlers,
    type VocabularyBackgroundContext,
} from '@/src/features/vocabulary/background';

export {createMaterialBackgroundHandler, type MaterialBackgroundContext} from '@/src/features/vocabulary/materialBackground';

import browser from 'webextension-polyfill';
import type {Config} from '@/src/core/config/model';
import {vocabularyBookDb, type VocabularyBookRepository} from '@/src/features/vocabulary/repository';
import {VocabularyPersistentUndo} from '@/src/features/vocabulary/background/persistentUndo';
import {isTrustedSettingsSender} from './trustedSettingsSender';
import {MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {MATERIAL_CHANGED_MESSAGE} from '@/src/features/vocabulary/materialProtocol';
import {createMaterialBackgroundHandler} from '@/src/features/vocabulary/materialBackground';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';

/** 扩展后台拥有持久撤销，并限制仅设置页能读取或操作删除票据。 */
export function createBrowserVocabularyUndoOptions() {
    return {
        vocabularyUndo: new VocabularyPersistentUndo(vocabularyBookDb),
        isTrustedUndoSender: (sender: Parameters<typeof isTrustedSettingsSender>[0]) => browser.extension.inIncognitoContext !== true
            && isTrustedSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('options.html')),
    };
}

/** 将本地材料端口绑定到扩展权限、已有收藏与隐私开关，保持总 runtime 注册函数紧凑。 */
export function createBrowserMaterialHandler(dependencies: {
    ready: Promise<unknown>;
    config: Pick<Config, 'on' | 'vocabularyBookEnabled' | 'harness' | 'disabledExtensionDomains'>;
    vocabularyBook: Pick<VocabularyBookRepository, 'list'>;
}) {
    const config = dependencies.config;
    return createMaterialBackgroundHandler({
        repository: new MaterialRepository(undefined, () => dependencies.vocabularyBook.list({order: 'recent'})),
        ready: dependencies.ready,
        isPrivateContext: () => browser.extension.inIncognitoContext === true,
        isExtensionUrl: url => url.startsWith(browser.runtime.getURL('/')),
        canCapture: (kind, sourceUrl) => {
            if (sourceUrl && (!config.on || isExtensionDisabledOnSite(sourceUrl, config.disabledExtensionDomains))) return false;
            // 独立材料保存与位置更新不依赖 AI 或词书；memoryEnabled 只控制模型回忆。
            if (kind === undefined) return config.on;
            return kind === 'vocabulary' ? config.vocabularyBookEnabled === true
                : kind === 'note' || kind === 'memory' || config.harness.enabled || config.vocabularyBookEnabled;
        },
        changed: () => {void browser.runtime.sendMessage({type: MATERIAL_CHANGED_MESSAGE}).catch(() => undefined);},
    });
}

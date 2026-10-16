/**
 * @file src/app/background/configStorageRuntime.ts
 *
 * 文件职责：把后台配置 IndexedDB 端口连接到 OCR 元数据仓库和浏览器变化广播，装配 Safari 会话接收者存储与标签关闭监听。
 * 主要内容：创建 OCR 加密存储 adapter，向共享网页接收者策略注入 browser runtime/tabs/session API，并安装键级变化通知及扩展页面通知。
 * 模块边界：本文件是后台 composition glue，不实现加密、迁移、授权或 OCR 领域规则；纯广播策略与配置仓库分别在相邻模块中测试。
 */

import {configStorage} from '@/src/platform/storage/configStorageRuntime';
import type {ImageOcrLanguageStorage} from '@/src/features/image-translation/background/ocrLanguageRepository';
import {installConfigStorageBroadcast} from './configStorageBroadcast';
import {createTabBroadcastRuntime, TAB_BROADCAST_SESSION_KEY, type TabBroadcastRuntime} from './tabBroadcast';

export function installBrowserTabBroadcastRuntime(browserName: string): TabBroadcastRuntime {
    const tabBroadcast = createTabBroadcastRuntime({
        browserName,
        extensionId: browser.runtime.id,
        isExtensionUrl: url => url.startsWith(browser.runtime.getURL('/')),
        queryTabs: () => browser.tabs.query({}) as Promise<Array<{id?: number}>>,
        sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
        readSessionRecipients: async () => (await browser.storage.session.get(TAB_BROADCAST_SESSION_KEY))[TAB_BROADCAST_SESSION_KEY],
        writeSessionRecipients: tabIds => browser.storage.session.set({[TAB_BROADCAST_SESSION_KEY]: tabIds}),
        warn: message => console.warn(message),
    });
    // 安装先于任何异步会话读取，加载期间的移除同样进入串行队列。
    browser.tabs.onRemoved.addListener((tabId: number) => {void tabBroadcast.removeTab(tabId);});
    return tabBroadcast;
}

export function createConfigImageOcrLanguageStorage(): ImageOcrLanguageStorage {
    return {
        get: async key => ({[key]: await configStorage.getItem(`local:${key}`)}),
        set: async values => {
            await Promise.all(Object.entries(values).map(([key, value]) => (
                configStorage.setItem(`local:${key}`, value)
            )));
        },
    };
}

export function installBrowserConfigStorageBroadcast(tabBroadcast: TabBroadcastRuntime): () => void {
    return installConfigStorageBroadcast(configStorage, {
        sendRuntimeMessage: message => browser.runtime.sendMessage(message),
        queryTabs: tabBroadcast.queryTabs,
        sendTabMessage: tabBroadcast.sendTabMessage,
        broadcastTabMessage: tabBroadcast.broadcastTabMessage,
        warn: (message, error) => console.warn(message, error),
    });
}

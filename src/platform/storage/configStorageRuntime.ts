/**
 * @file src/platform/storage/configStorageRuntime.ts
 *
 * 文件职责：按当前扩展运行上下文装配唯一配置存储端口，使后台持有加密 IndexedDB，其他页面只通过 runtime 代理访问。
 * 主要内容：识别 Chrome/Edge MV3 service worker 与 Firefox MV2 background page，收紧旧 storage 的 content 访问级别，连接会话随机材料与旧 Firefox 内存降级，并为非浏览器测试环境提供明确失败端口。
 * 模块边界：本文件是浏览器 composition glue，不实现加密、迁移、授权或消息处理；这些行为分别位于 configEncryption、configRepository、configStorage 与后台 handler。
 */

import {storage as legacyStorage} from '@wxt-dev/storage';
import {EncryptedConfigRepository} from './configRepository';
import {
    createBackgroundConfigStorage,
    createRemoteConfigStorage,
    createSessionKeyMaterialProvider,
    type ConfigStoragePort,
    type ConfigStorageRuntimePort,
    type LegacyConfigStoragePort,
} from './configStorage';

export function isBackgroundContext(): boolean {
    const protocol = globalThis.location?.protocol;
    const extensionOrigin = protocol === 'chrome-extension:'
        || protocol === 'moz-extension:'
        || protocol === 'safari-web-extension:';
    if (!extensionOrigin) return false;
    if (typeof document === 'undefined') return true;
    try {
        return browser.extension?.getBackgroundPage?.() === globalThis.window;
    } catch {
        return false;
    }
}

const unavailableStorage: ConfigStoragePort = {
    writeOwner: false,
    async getItem() { throw new Error('配置存储运行时不可用'); },
    async setItem() { throw new Error('配置存储运行时不可用'); },
    async removeItem() { throw new Error('配置存储运行时不可用'); },
    watch() { return () => undefined; },
};

function restrictLegacyStorageToTrustedContexts(): void {
    type RestrictedStorageArea = {
        setAccessLevel?: (options: {accessLevel: 'TRUSTED_CONTEXTS'}) => Promise<void>;
    };
    for (const name of ['local', 'session'] as const) {
        const warn = (error: unknown) => {
            console.warn('[FluentRead] 配置旧存储访问级别收紧失败', error);
        };
        try {
            const area = browser.storage?.[name] as RestrictedStorageArea | undefined;
            if (!area) continue;
            if (typeof area.setAccessLevel !== 'function') continue;
            void area.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(warn);
        } catch (error) {
            // 与异步拒绝保持一致：一个区域失败不能阻止其他区域尝试收紧或配置恢复。
            warn(error);
        }
    }
}

function createRuntimeConfigStorage(): ConfigStoragePort {
    if (isBackgroundContext()) {
        restrictLegacyStorageToTrustedContexts();
        const legacy = legacyStorage as unknown as LegacyConfigStoragePort;
        let sessionStorageApiAvailable = true;
        try {
            sessionStorageApiAvailable = typeof browser.storage?.session?.get === 'function'
                && typeof browser.storage?.session?.set === 'function';
        } catch {
            // API 属性读取本身异常时按“存在但暂时故障”处理，禁止生成新内存 key
            // 后误删仍可恢复的会话密文。
            sessionStorageApiAvailable = true;
        }
        const allowMemoryFallback = globalThis.location?.protocol === 'moz-extension:'
            && typeof document !== 'undefined'
            && !sessionStorageApiAvailable;
        return createBackgroundConfigStorage({
            legacy,
            repository: new EncryptedConfigRepository({
                getSessionKeyMaterial: createSessionKeyMaterialProvider(legacy, {allowMemoryFallback}),
            }),
        });
    }
    return typeof browser !== 'undefined'
        ? createRemoteConfigStorage(browser.runtime as unknown as ConfigStorageRuntimePort)
        : unavailableStorage;
}

export const configStorage = createRuntimeConfigStorage();

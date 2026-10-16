/**
 * @file src/app/background/handlers/configStorage.ts
 *
 * 文件职责：在后台唯一配置数据库边界为 popup、options、document 与 content 提供受 sender 授权的只读配置记录快照。
 * 主要内容：校验 configStorageRead 消息键、等待配置仓库初始化、限制记录读取权限，在网页快照读取前登记实际通知接收者；为 Popup 提供只包含引导状态的启动提示。
 * 模块边界：本文件不直接打开 IndexedDB、不解密记录、不修改配置或广播变化；具体读取端口和扩展 URL 判断由 background composition root 注入。
 */

import {
    CONFIG_INDEXED_DB_KEYS,
    CONFIG_STORAGE_READ_MESSAGE,
    type ConfigIndexedDbKey,
} from '@/src/platform/storage/configStorage';
import {sanitizeConfigCredentials} from '@/src/core/config/credentials';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from './configPersistence';

const CREDENTIAL_KEYS = new Set<ConfigIndexedDbKey>([
    'local:credentials',
    'session:credentials',
]);

export interface ConfigStorageReadMessage {
    type: typeof CONFIG_STORAGE_READ_MESSAGE;
    key?: unknown;
}

export interface ConfigStorageReadResponse {
    success: true;
    value: unknown;
}

export interface ConfigStorageReadDependencies {
    ready: Promise<unknown>;
    read(key: ConfigIndexedDbKey): Promise<unknown>;
    isExtensionUrl(url: string): boolean;
    registerContentReceiver?(sender: ConfigPersistenceContext['sender']): Promise<void>;
}

function parseKey(value: unknown): ConfigIndexedDbKey {
    if (typeof value !== 'string' || !CONFIG_INDEXED_DB_KEYS.includes(value as ConfigIndexedDbKey)) {
        throw new TypeError('配置存储读取键无效');
    }
    return value as ConfigIndexedDbKey;
}

export function createConfigStorageReadHandler(
    dependencies: ConfigStorageReadDependencies,
): BackgroundMessageHandler<ConfigPersistenceContext, ConfigStorageReadMessage, ConfigStorageReadResponse> {
    return {
        type: CONFIG_STORAGE_READ_MESSAGE,
        async handle(message, context) {
            const key = parseKey(message.key);
            const senderUrl = typeof context.sender?.url === 'string' ? context.sender.url : '';
            const trustedExtensionPage = dependencies.isExtensionUrl(senderUrl);
            if (!trustedExtensionPage && key !== 'local:config') {
                throw new Error(CREDENTIAL_KEYS.has(key)
                    ? '当前上下文无权读取配置凭据'
                    : '当前上下文无权读取该配置记录');
            }
            await dependencies.ready;
            if (!trustedExtensionPage && key === 'local:config') {
                try {await dependencies.registerContentReceiver?.(context.sender);}
                catch {console.warn('[FluentRead] 网页配置通知登记失败');}
            }
            const value = await dependencies.read(key);
            return {
                success: true,
                value: trustedExtensionPage ? value : sanitizeConfigCredentials(value),
            };
        },
    };
}

/** 启动提示只供模块预取；Popup 仍通过配置 store 新读快照后决定实际页面。 */
export function createPopupStartupHandler(dependencies: {
    ready: Promise<unknown>;
    getSetupCompleted(): boolean;
    isExtensionUrl(url: string): boolean;
}): BackgroundMessageHandler<ConfigPersistenceContext> {
    return {
        type: 'popupStartup',
        async handle(_message, context) {
            const senderUrl = typeof context.sender?.url === 'string' ? context.sender.url : '';
            if (!dependencies.isExtensionUrl(senderUrl)) throw new Error('当前上下文无权读取菜单启动提示');
            await dependencies.ready;
            return {success: true, uiLanguageSetupCompleted: dependencies.getSetupCompleted()};
        },
    };
}

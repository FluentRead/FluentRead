/**
 * @file src/app/background/handlers/uiLanguageBase.ts
 * 文件职责：为内容脚本提供受限的远程界面语言基线加载消息处理器，在扩展唯一安全源中校验、缓存并共享语言基线。
 * 主要内容：校验发送方同扩展身份与语言白名单，忽略消息中的任何未授权 URL/哈希字段，委托 loadPinnedRemoteUiLanguageBase 加载固定版本基线并返回。
 * 模块边界：仅处理 loadUiLanguageBase 消息；不修改全局配置、不直接注册内容脚本 i18n，也不接受任意远程资源地址。
 */
import {isRemoteDeltaUiLanguage, type RemoteDeltaUiLanguage} from '@/src/core/i18n/remoteLanguagePacks';
import type {UiLanguageBundle} from '@/src/core/i18n';
import {
    loadPinnedRemoteUiLanguageBase,
    UI_LANGUAGE_BASE_MESSAGE_TYPE,
    type UiLanguageBaseRequest,
    type UiLanguageBaseResponse,
} from '@/src/platform/i18n/uiLanguageBundles';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';

export interface UiLanguageBaseHandlerDependencies {
    readonly runtimeId: string;
    readonly loadBase?: (language: RemoteDeltaUiLanguage) => Promise<UiLanguageBundle>;
}

export function createUiLanguageBaseHandler(
    dependencies: UiLanguageBaseHandlerDependencies,
): BackgroundMessageHandler<unknown, UiLanguageBaseRequest, UiLanguageBaseResponse> {
    const loadBase = dependencies.loadBase ?? loadPinnedRemoteUiLanguageBase;
    return {
        type: UI_LANGUAGE_BASE_MESSAGE_TYPE,
        async handle(message, context) {
            const sender = (context as {sender?: {id?: unknown}} | undefined)?.sender;
            if (sender?.id !== dependencies.runtimeId) {
                return {success: false, error: '当前上下文无权加载界面语言基线'};
            }
            const language = (message as {language?: unknown} | undefined)?.language;
            if (typeof language !== 'string' || !isRemoteDeltaUiLanguage(language)) {
                return {success: false, error: '不支持的远程界面语言'};
            }
            return {success: true, bundle: await loadBase(language)};
        },
    };
}

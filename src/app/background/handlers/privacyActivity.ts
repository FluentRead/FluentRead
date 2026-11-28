/**
 * @file src/app/background/handlers/privacyActivity.ts
 * 文件职责：为设置页提供类型化的翻译隐私防护脱敏与拦截记录查询及清空后台消息处理器。
 * 主要内容：严格限制调用来源为扩展设置页（options），校验 query/clear 动作并把仓库结果或存储错误转换为稳定响应。
 * 模块边界：不直接访问浏览器存储、不执行敏感信息检测，也不格式化界面文案；仓库由后台组合根注入。
 */
import {
    PRIVACY_ACTIVITY_MESSAGE_TYPE,
    type PrivacyActivityMessage,
    type PrivacyActivityResponse,
    type PrivacyActivitySnapshot,
} from '@/src/core/privacy/activity';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from './configPersistence';

export interface PrivacyActivityRepositoryContract {
    getSnapshot(): Promise<PrivacyActivitySnapshot>;
    clear(): Promise<void>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
        ? error.message
        : '隐私防护记录暂时不可用';
}

export function createPrivacyActivityHandler(
    repository: PrivacyActivityRepositoryContract,
    isOptionsUrl: (url: string) => boolean,
): BackgroundMessageHandler<ConfigPersistenceContext, PrivacyActivityMessage, PrivacyActivityResponse> {
    return {
        type: PRIVACY_ACTIVITY_MESSAGE_TYPE,
        async handle(message, context) {
            try {
                const senderUrl = typeof context.sender?.url === 'string' ? context.sender.url : '';
                if (!isOptionsUrl(senderUrl)) throw new Error('当前上下文无权访问隐私防护记录');
                if (message.action === 'query') {
                    return {success: true, data: await repository.getSnapshot()};
                }
                if (message.action === 'clear') {
                    await repository.clear();
                    return {success: true, data: {cleared: true}};
                }
                return {success: false, error: '不支持的隐私防护记录操作'};
            } catch (error) {
                return {success: false, error: errorMessage(error)};
            }
        },
    };
}

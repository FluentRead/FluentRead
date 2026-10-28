/**
 * @file src/app/background/chatgptPlanRuntime.ts
 * 文件职责：装配仅扩展设置页面可调用的 ChatGPT 套餐连接 handler。
 * 主要内容：校验发送者及开发构建开关，公共版本在任何本机调用前返回未开放状态；开发实验委托助手端口、打开固定官方授权或用量页、返回安全状态和错误代码。
 * 模块边界：本文件只组装 background 消息能力，不接收任意端点、不向网页/content 返回配对凭证和 OAuth 令牌。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import type {ConfigPersistenceContext} from './handlers/configPersistence';
import {isTrustedSettingsSender} from './handlers/trustedSettingsSender';
import {chatGPTPlanBridge, CHATGPT_PLAN_USAGE_URL, ChatGPTPlanError} from '@/src/platform/chatgpt-plan/bridge';
import {CHATGPT_PLAN_MESSAGE_TYPE} from '@/src/services/chatgpt-plan/client';
import {chatGPTPlanDevelopmentEnabled} from '@/src/platform/chatgpt-plan/buildMode';
interface ChatGPTPlanMessage {type: typeof CHATGPT_PLAN_MESSAGE_TYPE; action?: unknown; code?: unknown; newAccount?: unknown}
export function createChatGPTPlanHandler(
    bridge = chatGPTPlanBridge,
    trusted: (sender: ConfigPersistenceContext['sender']) => boolean = sender => isTrustedSettingsSender(sender, browser.runtime.id, browser.runtime.getURL('/options.html')),
    open: (url: string) => Promise<unknown> = url => browser.tabs.create({url}),
    enabled = chatGPTPlanDevelopmentEnabled,
): BackgroundMessageHandler<ConfigPersistenceContext, ChatGPTPlanMessage> {
    return {type: CHATGPT_PLAN_MESSAGE_TYPE, async handle(message, context) {
        if (!trusted(context.sender)) return {success: false, code: 'not_connected'};
        if (!enabled) return {success: false, code: 'public_unavailable'};
        const operation = message;
        try {
            let data: unknown;
            if (operation.action === 'status') data = await bridge.status();
            else if (operation.action === 'pair' && typeof operation.code === 'string') data = await bridge.pair(operation.code);
            else if (operation.action === 'signIn' && (operation.newAccount === undefined || typeof operation.newAccount === 'boolean')) {await open(await bridge.signIn(operation.newAccount)); data = await bridge.status();}
            else if (operation.action === 'cancel') data = await bridge.cancelSignIn();
            else if (operation.action === 'disconnect') data = await bridge.disconnect();
            else if (operation.action === 'models') data = await bridge.models();
            else if (operation.action === 'usage') {await open(CHATGPT_PLAN_USAGE_URL);}
            else return {success: false, code: 'invalid_response'};
            return {success: true, data};
        } catch (error) {return {success: false, code: error instanceof ChatGPTPlanError ? error.code : 'helper_unavailable'};}
    }};
}

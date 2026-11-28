/**
 * @file src/app/background/commandPaletteNavigation.ts
 * 文件职责：处理来自内容脚本命令面板的扩展页面导航请求，提供文档翻译工作台和原生翻译侧边栏的后台安全打开能力。
 * 主要内容：实现 openDocumentWorkspace 与 openTranslationSidepanel 两个后台消息处理器，严格校验扩展内部发送者身份，并在原生侧边栏不可用或缺少用户手势时回退到设置页翻译中心。
 * 模块边界：仅封装可测试的后台路由处理器，不直接绑定 browser.runtime 监听；由 popupNavigation 装配到全局消息路由。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';

export interface CommandPaletteNavigationSender {
    readonly id?: string;
    readonly tab?: {readonly id?: number; readonly windowId?: number};
}

export interface CommandPaletteNavigationContext {
    readonly sender?: CommandPaletteNavigationSender;
}

export interface CommandPaletteNavigationPorts {
    readonly extensionId: string;
    readonly openDocumentWorkspace: (windowId?: number) => Promise<void>;
    readonly openSidepanel: (tabId?: number, windowId?: number) => Promise<boolean>;
    readonly openTranslationCenterFallback: () => Promise<void>;
}

export type CommandPaletteNavigationResponse = {readonly success: boolean};

export function createCommandPaletteNavigationHandlers<
    Context extends CommandPaletteNavigationContext,
>(ports: CommandPaletteNavigationPorts) {
    const openDocumentHandler: BackgroundMessageHandler<
        Context,
        {type: 'openDocumentWorkspace'},
        CommandPaletteNavigationResponse
    > = {
        type: 'openDocumentWorkspace',
        async handle(_message, {sender}) {
            if (sender?.id !== ports.extensionId) return {success: false};
            await ports.openDocumentWorkspace(sender.tab?.windowId);
            return {success: true};
        },
    };

    const openSidepanelHandler: BackgroundMessageHandler<
        Context,
        {type: 'openTranslationSidepanel'},
        CommandPaletteNavigationResponse
    > = {
        type: 'openTranslationSidepanel',
        async handle(_message, {sender}) {
            if (sender?.id !== ports.extensionId) return {success: false};
            try {
                const opened = await ports.openSidepanel(sender.tab?.id, sender.tab?.windowId);
                if (opened) return {success: true};
            } catch {
                // 部分浏览器要求扩展工具栏手势才能展开原生侧边栏；失败时平滑回退到翻译中心。
            }
            await ports.openTranslationCenterFallback();
            return {success: true};
        },
    };

    return [openDocumentHandler, openSidepanelHandler] as const;
}

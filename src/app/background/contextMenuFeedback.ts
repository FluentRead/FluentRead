/**
 * @file src/app/background/contextMenuFeedback.ts
 * 文件职责：把右键失败原因交付给点击所在页面的通知层，让未启动的操作有清晰反馈。
 * 主要内容：优先向右键所在 frame 发送有限原因，子 frame 接收者消失时回退到顶层；每次交付前检查文档归属。
 * 模块边界：只发送不含选区、URL 或异常详情的反馈消息，不重试翻译、不切换标签页、不增加浏览器权限；通知样式与生命周期由现有 page-notice feature 管理。
 */
import type {ContextMenuFailureReason} from '@/src/core/context-menu/feedback';
import type {ContextMenuClickInfo} from './contextMenuActions';
import {withContextMenuDeadline} from './contextMenuDelivery';

export async function reportContextMenuFailure(tabId: number, info: ContextMenuClickInfo,
    reason: ContextMenuFailureReason, isCurrent: () => boolean): Promise<void> {
    const frameId = Number.isInteger(info.frameId) && info.frameId! >= 0 ? info.frameId! : 0;
    for (const target of frameId === 0 ? [0] : [frameId, 0]) {
        if (!isCurrent()) return;
        try {
            const response = await withContextMenuDeadline(browser.tabs.sendMessage(tabId,
                {type: 'contextMenuNotice', reason}, {frameId: target}), 1500) as {status?: unknown} | undefined;
            if (response?.status === 'success') return;
        } catch {
            // 页面正在导航或浏览器禁止脚本运行时不弹出新页，也不自动重发用户的翻译操作。
        }
    }
}

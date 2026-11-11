/**
 * @file src/app/background/runtime.ts
 * 文件职责：作为扩展后台应用的顶层启动函数，按唯一顺序组装标签页状态、右键菜单、消息监听和后台维护任务。
 * 主要内容：创建共享 TabTranslationStateStore，安装请求头网络规则、Thunderbird 邮件脚本、菜单、工具栏点击、角标与消息 runtime，最后注册后台维护任务。
 * 模块边界：本文件只负责后台生命周期启动，不实现消息分派、菜单规则、配置历史或缓存算法；WXT entrypoint 仅调用 startBackgroundApp，各子系统由相邻模块实现。
 */
import {installBackgroundMaintenance} from './maintenanceRuntime';
import {installRequestHeaderRuntime} from './requestHeaderRuntime';
import {installBackgroundContextMenus} from './contextMenuRuntime';
import {installBackgroundBadge} from './badgeRuntime';
import {installToolbarActionRuntime} from './toolbarActionRuntime';
import {installBackgroundMessageRuntime} from './messageRuntime';
import {TabTranslationStateStore} from './tabTranslationState';
import {installThunderbirdMessageRuntime, type ThunderbirdMessageApi} from './thunderbirdMessageRuntime';
const tabTranslationStates = new TabTranslationStateStore();
/** 启动一次 MV2 background page 或 MV3 service worker 实例。 */
export function startBackgroundApp(): void {
    installRequestHeaderRuntime();
    installThunderbirdMessageRuntime(browser as unknown as ThunderbirdMessageApi);
    const contextMenus = installBackgroundContextMenus(tabTranslationStates);
    installToolbarActionRuntime(tabTranslationStates);
    const badge = installBackgroundBadge(tabTranslationStates);
    installBackgroundMessageRuntime({
        tabTranslationStates,
        onFullPageStateChanged: (tabId) => {
            if (contextMenus.isSupported) void contextMenus.update(tabId);
            if (badge.isSupported) void badge.update(tabId);
        },
    });
    installBackgroundMaintenance();
}

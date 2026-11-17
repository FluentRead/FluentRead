/**
 * @file src/features/hypothesis/injection.ts
 * 文件职责：校验网页顶层内容脚本请求，并在其原标签页注入随包官方客户端。
 * 主要内容：拒绝外部、子框架、已导航和禁用来源；MV3 绑定 documentId，MV2 使用本地脚本内的文档守卫。
 * 模块边界：只调用注入的浏览器端口，不下载或执行远程代码，不接收脚本路径、代码或登录凭据。
 */
import {isBrowserTabId} from '@/src/platform/browser/ids';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
interface Context {sender?: {id?: string; url?: string; frameId?: number; documentId?: string; tab?: {id?: number}}}
export interface HypothesisInjectionPorts {
    extensionId: string;
    enabled(url: string): Promise<boolean>;
    getTab(id: number): Promise<{url?: string; pendingUrl?: string}>;
    inject(tabId: number, documentId?: string): Promise<void>;
}
export function createHypothesisInjectionHandler<RuntimeContext extends Context>(ports: HypothesisInjectionPorts): BackgroundMessageHandler<RuntimeContext> {
    return {type: 'installHypothesisClient', async handle(_message, {sender}) {
        if (sender?.id !== ports.extensionId || sender.frameId !== 0 || !isBrowserTabId(sender.tab?.id)
            || !sender.url || !/^(https?|file):\/\//u.test(sender.url)) return {status: 'unavailable'};
        try {
            if (!await ports.enabled(sender.url)) return {status: 'disabled'};
            const tab = await ports.getTab(sender.tab!.id!);
            if ((tab.pendingUrl || tab.url) !== sender.url) return {status: 'unavailable'};
            await ports.inject(sender.tab!.id!, sender.documentId);
            return {status: 'success'};
        } catch {return {status: 'failed'};}
    }};
}

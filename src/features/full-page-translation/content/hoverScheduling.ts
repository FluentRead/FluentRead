/**
 * @file src/features/full-page-translation/content/hoverScheduling.ts
 * 文件职责：管理悬浮翻译在当前页面请求会话内的唯一待执行延时，阻止失效手势在路由切换、关闭或隐藏后启动翻译。
 * 主要内容：替换与取消待执行 timer，冻结调度时的请求会话与提交代次，在回调执行前复验会话所有权、页面可见性和启用状态；0ms 调度仍经过同一生命周期门禁。
 * 模块边界：只管理全文功能共享的悬浮调度，不发现候选、不捕获翻译配置、不渲染译文也不取消已发出的请求；runtime 继续负责候选解析与 translateTarget。
 */
import {config} from '@/src/services/config/store';
import {getHoverTranslationRequestSession} from './requestSession';

let hoverTimer: ReturnType<typeof setTimeout> | undefined;

export function isHoverTranslationAvailable(): boolean {
    return document.visibilityState !== 'hidden' && config.on !== false;
}

export function cancelPendingHoverTranslation(): void {
    if (hoverTimer === undefined) return;
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
}

export function scheduleHoverTranslation(callback: () => void, delayMs: number): void {
    cancelPendingHoverTranslation();
    if (!isHoverTranslationAvailable()) return;
    const requestSession = getHoverTranslationRequestSession();
    const requestGeneration = requestSession.renderCommitGeneration;
    hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        if (!isHoverTranslationAvailable()
            || getHoverTranslationRequestSession() !== requestSession
            || requestSession.renderCommitGeneration !== requestGeneration) return;
        callback();
    }, delayMs);
}

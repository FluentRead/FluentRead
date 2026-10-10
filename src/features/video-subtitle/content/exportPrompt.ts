/**
 * @file src/features/video-subtitle/content/exportPrompt.ts
 * 文件职责：在播放器字幕菜单内呈现导出缺口，并取得补译、仅已有结果或取消的明确选择。
 * 主要内容：显示冻结预览的条目、人工轨/缓存命中、去重请求量与时间跨度；复用菜单样式和本地化标记，取消时移除监听、节点并恢复原操作焦点。
 * 模块边界：只操作传入菜单的节点，不请求翻译、不读取配置或缓存，任务身份与失效由下载协调器拥有。
 */
import type {VideoSubtitleExportChoice, VideoSubtitleExportPreview} from './downloads';
import {syncVideoPlayerMenuLayout} from './playerMenu';

function timestamp(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(part => String(part).padStart(2, '0')).join(':');
}

/** 不使用页面级 confirm；同一菜单中查看真实补译量后再开始服务请求。 */
export function confirmVideoSubtitleExport(menu: HTMLElement, preview: VideoSubtitleExportPreview, bilingual: boolean,
    signal: AbortSignal, ui: (key: string, params?: Record<string, string | number>) => string): Promise<VideoSubtitleExportChoice> {
    if (signal.aborted) return Promise.resolve('cancel');
    const doc = menu.ownerDocument;
    const main = menu.querySelector<HTMLElement>('.fluent-read-video-menu-main');
    const previousFocus = doc.activeElement as HTMLElement | null;
    const previousView = menu.dataset.view;
    const panel = doc.createElement('section');
    panel.className = 'fluent-read-video-model-prompt fluent-read-video-export-prompt';
    panel.dataset.exportPrompt = 'true';
    panel.setAttribute('role', 'group');
    panel.dataset.i18nAriaKey = 'video.exportPreviewTitle';
    panel.setAttribute('aria-label', ui('video.exportPreviewTitle'));
    const text = (tag: 'p' | 'strong' | 'button', key: string, params?: Record<string, string | number>) => {
        const node = doc.createElement(tag);
        node.dataset.i18nKey = key;
        if (params) node.dataset.i18nParams = JSON.stringify(params);
        node.textContent = ui(key, params);
        return node;
    };
    const title = text('strong', 'video.exportPreviewTitle');
    title.className = 'fluent-read-video-model-prompt-title';
    const summary = text('p', 'video.exportPreviewSummary', {total: preview.total, ready: preview.ready, missing: preview.missing});
    const requests = text('p', 'video.exportPreviewRequests', {requests: preview.requests, human: preview.human, cached: preview.cached});
    const notice = text('p', 'video.exportPreviewNotice');
    for (const node of [summary, requests, notice]) node.className = 'fluent-read-video-model-prompt-description';
    panel.append(title, summary, requests);
    if (preview.startMs !== null && preview.endMs !== null) {
        const range = text('p', 'video.exportPreviewRange', {start: timestamp(preview.startMs), end: timestamp(preview.endMs)});
        range.className = 'fluent-read-video-model-prompt-description';
        panel.appendChild(range);
    }
    panel.appendChild(notice);
    const actions = doc.createElement('div');
    actions.className = 'fluent-read-video-model-prompt-actions fluent-read-video-export-actions';
    const complete = text('button', preview.missing ? 'video.exportComplete' : bilingual ? 'video.downloadBilingual' : 'video.downloadTranslated') as HTMLButtonElement;
    complete.className = 'fluent-read-video-model-prompt-confirm';
    complete.dataset.exportChoice = 'complete';
    const existing = text('button', 'video.exportExisting', {count: preview.ready}) as HTMLButtonElement;
    existing.className = 'fluent-read-video-model-prompt-cancel';
    existing.dataset.exportChoice = 'existing';
    existing.disabled = preview.ready === 0;
    existing.hidden = preview.missing === 0;
    const cancel = text('button', 'video.exportCancel') as HTMLButtonElement;
    cancel.className = 'fluent-read-video-model-prompt-cancel';
    cancel.dataset.exportChoice = 'cancel';
    for (const button of [complete, existing, cancel]) { button.type = 'button'; button.setAttribute('role', 'menuitem'); }
    actions.append(complete, existing, cancel); panel.appendChild(actions);
    if (main) main.hidden = true;
    menu.dataset.view = 'export-prompt';
    menu.appendChild(panel);
    return new Promise(resolve => {
        const finish = (choice: VideoSubtitleExportChoice) => {
            panel.removeEventListener('click', click);
            panel.removeEventListener('keydown', keydown);
            signal.removeEventListener('abort', abort);
            panel.remove();
            if (main) main.hidden = false;
            menu.dataset.view = previousView || 'main';
            if (!menu.hidden && previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus();
            syncVideoPlayerMenuLayout(menu);
            resolve(choice);
        };
        const click = (event: MouseEvent) => {
            if (!event.isTrusted) return;
            const target = event.target as HTMLElement | null;
            const button = target?.closest<HTMLButtonElement>('[data-export-choice]');
            if (!button || button.disabled || !panel.contains(button)) return;
            event.preventDefault(); event.stopPropagation();
            finish(button.dataset.exportChoice as VideoSubtitleExportChoice);
        };
        const keydown = (event: KeyboardEvent) => {
            if (!event.isTrusted || event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation(); finish('cancel');
        };
        const abort = () => finish('cancel');
        panel.addEventListener('click', click);
        panel.addEventListener('keydown', keydown);
        signal.addEventListener('abort', abort, {once: true});
        // 节点创建和布局、焦点回调都可能同步取消；注册后检查已取消状态，再交出焦点。
        if (signal.aborted) { abort(); return; }
        syncVideoPlayerMenuLayout(menu);
        if (!signal.aborted) cancel.focus();
    });
}

/**
 * @file src/features/image-translation/content/controls.ts
 * 文件职责：创建图片翻译的轻量操作条，持续展示读取、识别、翻译与失败状态，支持取消、重试和首次语言准备。
 * 主要内容：提供隔离样式、可信手势按钮与可选全文详情；长译文可选择复制，减少只能看位图的阅读障碍。
 * 模块边界：仅操作所属 Shadow DOM，不读取配置、不访问网络、不持有图片请求；业务动作及生命周期由 content/runtime 注入。
 */
export type ImageControlPhase = 'idle' | 'loading' | 'translated' | 'error';
export const IMAGE_CONTROLS_CSS = `
.fr-image-controls {position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);display:flex;flex-direction:column;align-items:flex-start;gap:6px;pointer-events:auto;font:12px/1.5 system-ui,sans-serif;color:#fff;z-index:2;}
.fr-image-actions {display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:3px;background:rgba(20,24,32,.9);border:1px solid #ffffff66;border-radius:18px;box-shadow:0 2px 8px #0003;}
.fr-image-controls button {all:unset;box-sizing:border-box;cursor:pointer;color:inherit;font:inherit;padding:4px 9px;border-radius:12px;white-space:nowrap;}
.fr-image-controls button:hover {background:#ffffff24;}
.fr-image-controls button:focus-visible {outline:2px solid #a7c5ff;outline-offset:2px;}
.fr-image-controls [hidden] {display:none!important;}
.fr-image-status {max-width:320px;padding:6px 9px;background:rgba(20,24,32,.92);border-radius:8px;overflow-wrap:anywhere;white-space:normal;}
.fr-image-controls[data-phase=error] .fr-image-status {background:#7f1d1df2;}
.fr-image-details {margin:0;padding:10px;max-height:160px;max-width:320px;overflow:auto;background:#fff;color:#182132;border:1px solid #dce2ea;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font:13px/1.6 system-ui,sans-serif;}
`;

export function createImageControls(actions: {onAction(): void; onPrepare(): void; onInspect?(): void; translate?(source: string): string}) {
    const localize = (source: string) => actions.translate?.(source) ?? source;
    const element = document.createElement('div');
    element.className = 'fr-image-controls';
    const status = document.createElement('div');
    status.className = 'fr-image-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const row = document.createElement('div');
    row.className = 'fr-image-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fluent-read-image-translation-button';
    const prepare = document.createElement('button');
    prepare.type = 'button';
    prepare.textContent = '下载语言包并重试';
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.textContent = '文字';
    inspect.setAttribute('aria-label', '查看完整译文');
    inspect.setAttribute('aria-expanded', 'false');
    const details = document.createElement('pre');
    details.className = 'fr-image-details';
    details.setAttribute('aria-label', '图片完整译文');
    details.tabIndex = 0;
    details.hidden = true;
    let phase: ImageControlPhase = 'idle';
    let sourceMessage = '翻译图片';
    const refreshLanguage = () => {
        prepare.textContent = localize('下载语言包并重试');
        inspect.textContent = localize('文字');
        inspect.setAttribute('aria-label', localize('查看完整译文'));
        details.setAttribute('aria-label', localize('图片完整译文'));
        button.textContent = localize(phase === 'loading' ? '取消' : phase === 'translated' ? '原图' : phase === 'error' ? '重试' : '翻译');
        button.title = localize(phase === 'loading' ? '取消图片翻译' : phase === 'translated' ? '恢复原图' : sourceMessage);
        button.setAttribute('aria-label', button.title);
        status.textContent = localize(sourceMessage);
    };
    let disposed = false;
    const handleClick = (event: MouseEvent) => {
        if (!event.isTrusted || disposed) return;
        event.stopPropagation();
        const target = event.target;
        if (target === button) actions.onAction();
        if (target === prepare) actions.onPrepare();
        if (target === inspect) {
            details.hidden = !details.hidden;
            inspect.setAttribute('aria-expanded', String(!details.hidden));
            actions.onInspect?.();
        }
    };
    const isolate = (event: Event) => event.stopPropagation();
    // 只隔离本操作条的输入，绝不在 document 注册会影响宿主快捷键/滚轮的监听器。
    element.addEventListener('click', handleClick);
    for (const event of ['pointerdown', 'keydown', 'keyup', 'wheel']) element.addEventListener(event, isolate);
    row.append(button, prepare, inspect);
    element.append(details, status, row);
    const update = (next: ImageControlPhase, message: string, options: {prepare?: boolean; animations?: boolean} = {}) => {
        phase = next;
        element.dataset.phase = next;
        button.dataset.phase = next;
        sourceMessage = message;
        refreshLanguage();
        status.hidden = next === 'idle' || next === 'translated';
        element.setAttribute('aria-busy', String(next === 'loading'));
        prepare.hidden = next !== 'error' || !options.prepare;
        inspect.hidden = next !== 'translated' || !details.textContent;
        if (next !== 'translated') {
            details.hidden = true;
            inspect.setAttribute('aria-expanded', 'false');
        }
    };
    update('idle', '翻译图片');
    return {
        element, button, status, update, refreshLanguage,
        setLines(lines: Array<{text: string}>) {
            details.textContent = lines.map(line => line.text).join('\n');
            inspect.hidden = phase !== 'translated' || lines.length === 0;
        },
        dispose() {
            disposed = true;
            element.removeEventListener('click', handleClick);
            for (const event of ['pointerdown', 'keydown', 'keyup', 'wheel']) element.removeEventListener(event, isolate);
            element.remove();
        },
    };
}

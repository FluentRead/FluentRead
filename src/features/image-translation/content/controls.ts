/**
 * @file src/features/image-translation/content/controls.ts
 * 文件职责：创建图片翻译的轻量操作条，支持单图反馈和不遮挡阅读的漫画模式，支持取消、重试和首次语言准备与模型/服务设置导航。
 * 主要内容：单图提供无额外外框的淡色图标入口、隔离操作条、可信手势按钮与全文详情，品牌提示沿用注入的界面本地化端口；漫画处理时在图片可见边缘延迟显示轻量进度，暂停会话后的单页排队可取消，失败时在同一边缘提供紧凑的重试、详情及设置入口，恢复动作先于独立滚动的长错误详情，完成或切回原图即撤下，不展开常驻阅读面板；任务旋转独立于装饰动画开关并保留系统减少动态效果偏好。
 * 模块边界：仅操作所属 Shadow DOM，不读取配置、不访问网络、不持有图片请求；业务动作及生命周期由 content/runtime 注入。
 */
import {createImageTextReader, IMAGE_READER_CSS, type ImageReaderLine} from './textReader';
import {normalizeImageProgress} from '../progress';
import brandIcon from '../../../../public/icon/32.png?inline';

export type ImageControlPhase = 'idle' | 'loading' | 'translated' | 'error';
// 沿用 ui/styles/tokens.css 的品牌、文字与表面色；在所属 Shadow UI 内声明，避免继承宿主变量。
export const IMAGE_CONTROLS_CSS = IMAGE_READER_CSS + `
.fr-image-controls,.fr-image-feedback {--fr-image-brand:#dc315f;--fr-image-brand-soft:#fff0f4;--fr-image-ink:#172033;--fr-image-muted:#737c8f;--fr-image-line:#e5e8ef;--fr-image-surface:#fff;color:var(--fr-image-ink);font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box;}
.fr-image-controls {position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);display:flex;flex-direction:column;align-items:flex-start;gap:6px;pointer-events:auto;z-index:2;}
.fr-image-feedback {position:absolute;left:50%;top:50%;width:max-content;display:flex;flex-direction:column;gap:8px;transform:translate(-50%,-50%);padding:12px 14px;border:1px solid var(--fr-image-line);border-radius:12px;background:var(--fr-image-surface);box-shadow:0 8px 28px rgba(27,36,57,.12),0 2px 6px rgba(27,36,57,.04);pointer-events:none;}
.fr-image-controls[hidden],.fr-image-feedback[hidden],.fr-image-controls [hidden],.fr-image-feedback [hidden] {display:none!important;}
.fr-image-feedback-title {font-size:14px;line-height:1.4;font-weight:650;}
.fr-image-status {display:flex;align-items:center;gap:9px;min-width:0;overflow-wrap:anywhere;white-space:normal;}
.fr-image-spinner {width:12px;height:12px;flex:0 0 auto;box-sizing:border-box;border:1.5px solid #b9aab333;border-top-color:#947985;border-radius:50%;animation:fr-image-spin .75s linear infinite;}
.fr-image-spinner[data-animated=false] {animation:none;}
.fr-image-actions {display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:2px;border:1px solid #ffffff66;border-radius:9px;background:rgba(250,251,253,.62);backdrop-filter:blur(6px);box-shadow:0 1px 5px rgba(27,36,57,.06);}
.fr-image-controls button,.fr-image-feedback button {all:unset;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:24px;padding:3px 7px;border-radius:6px;cursor:pointer;color:inherit;font:inherit;font-size:11px;font-weight:500;white-space:nowrap;}
.fr-image-controls button:hover,.fr-image-feedback button:hover {background:var(--fr-image-brand-soft);color:var(--fr-image-brand);}
.fr-image-controls button:focus-visible,.fr-image-feedback button:focus-visible {outline:2px solid var(--fr-image-brand);outline-offset:2px;}

.fr-image-controls .fr-image-actions {opacity:.48;transition:opacity 120ms ease,background-color 120ms ease;}
.fr-image-controls[data-phase=idle] .fr-image-actions {opacity:.28;padding:0;border:0;background:transparent;box-shadow:none;backdrop-filter:none;}
.fr-image-controls[data-phase=idle] .fluent-read-image-translation-button::before {filter:grayscale(1);}
.fr-image-controls[data-phase=idle]:hover .fluent-read-image-translation-button::before,.fr-image-controls[data-phase=idle]:focus-within .fluent-read-image-translation-button::before {filter:none;}
.fr-image-controls[data-phase=idle] .fr-image-actions:hover,.fr-image-controls[data-phase=idle]:focus-within .fr-image-actions,.fr-image-controls .fr-image-actions:hover,.fr-image-controls:focus-within .fr-image-actions {opacity:1;background:rgba(250,251,253,.92);}
.fr-image-controls[data-animations=false] .fr-image-actions {transition:none;}
.fr-image-controls[data-phase=idle] .fluent-read-image-translation-button {width:24px;height:24px;padding:5px;font-size:0;}
.fr-image-controls .fluent-read-image-translation-button::before {content:"";display:block;width:14px;height:14px;flex:0 0 auto;margin-right:5px;background:url("${brandIcon}") center/contain no-repeat;}
.fr-image-controls[data-phase=idle] .fluent-read-image-translation-button::before {margin-right:0;}
.fr-image-feedback-title::before {content:"";display:inline-block;width:16px;height:16px;margin-right:6px;vertical-align:-2px;background:url("${brandIcon}") center/contain no-repeat;}
.fr-image-feedback[data-phase=loading] {padding:6px 9px;border-color:#ffffff66;border-radius:9px;background:rgba(250,251,253,.6);backdrop-filter:blur(5px);box-shadow:0 1px 5px rgba(27,36,57,.06);color:#475569;font-size:11px;opacity:.8;}
.fr-image-feedback[data-phase=loading] .fr-image-status {gap:6px;}
.fr-image-feedback[data-phase=error] {width:340px;padding:16px;pointer-events:auto;overflow:auto;overscroll-behavior:contain;}
.fr-image-feedback[data-phase=error] .fr-image-status {color:#536074;}
.fr-image-feedback .fr-image-service-settings {order:-1;}
.fr-image-error-details {font-size:11px;color:var(--fr-image-muted);overflow-wrap:anywhere;}
.fr-image-error-details summary {cursor:pointer;}
.fr-image-error-details p {margin:6px 0 0;}
.fr-image-feedback .fr-image-actions {flex-shrink:0;padding:4px 0 0;border:0;border-radius:0;box-shadow:none;gap:8px;background:transparent;}
.fr-image-feedback[data-phase=error] .fr-image-error-details {min-height:0;overflow:auto;overscroll-behavior:contain;}
.fr-image-feedback button {min-height:32px;max-width:100%;padding:6px 12px;white-space:normal;text-align:center;overflow-wrap:anywhere;}
.fr-image-feedback .fr-image-prepare,.fr-image-feedback .fr-image-model-settings,.fr-image-feedback[data-preparation=false][data-recovery=false] .fluent-read-image-translation-button {order:-1;background:var(--fr-image-brand);color:#fff;font-weight:650;}
.fr-image-feedback .fr-image-prepare:hover,.fr-image-feedback .fr-image-model-settings:hover,.fr-image-feedback[data-preparation=false][data-recovery=false] .fluent-read-image-translation-button:hover {background:#c62752;color:#fff;}
.fr-image-feedback .fr-image-dismiss,.fr-image-feedback[data-preparation=true] .fluent-read-image-translation-button {color:var(--fr-image-muted);}
 .fr-image-feedback[data-manga=true][data-phase=loading] {flex-direction:row;align-items:center;gap:6px;transform:none;min-width:0;padding:6px 9px;font-size:11px;pointer-events:none;animation:fr-manga-feedback .12s ease .15s both;}
.fr-image-feedback[data-manga=true] .fr-image-status {gap:6px;min-width:0;}
.fr-image-feedback[data-manga=true] .fr-image-status>span:last-child {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fr-image-feedback[data-manga=true][data-phase=loading][data-queued=true] {pointer-events:auto;}
.fr-image-feedback[data-manga=true][data-queued=true] .fr-image-actions {padding:0;gap:0;}
.fr-image-feedback[data-manga=true][data-queued=true] .fluent-read-image-translation-button {min-height:24px;padding:3px 7px;background:transparent;color:inherit;font-weight:500;}
.fr-image-feedback[data-manga=true][data-phase=error] {width:280px;max-width:280px;transform:none;gap:5px;padding:8px 10px;border-color:#ffffff99;background:rgba(250,251,253,.94);box-shadow:0 2px 8px rgba(27,36,57,.08);font-size:11px;}
.fr-image-feedback[data-manga=true][data-phase=error] .fr-image-status>span:last-child {display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;min-width:0;flex:1;}
.fr-image-feedback[data-manga=true][data-phase=error] .fr-image-actions {gap:4px;padding:0;}
.fr-image-feedback[data-manga=true][data-phase=error] button {min-height:28px;padding:4px 7px;font-size:11px;}
.fr-image-progress {height:2px;width:36px;flex:0 0 36px;border-radius:2px;background:#47556930;overflow:hidden;}
.fr-image-progress>span {display:block;height:100%;background:#947985;border-radius:inherit;}
@keyframes fr-manga-feedback {from {opacity:0;} to {opacity:1;}}
@keyframes fr-image-spin {to {transform:rotate(360deg);}}
@media (prefers-reduced-motion: reduce) {.fr-image-spinner {animation:none;}.fr-image-controls .fr-image-actions {transition:none;}}
@media (prefers-reduced-motion: reduce) {.fr-image-feedback[data-manga=true][data-phase=loading] {animation-duration:0s;}}
.fr-image-feedback[data-manga=true][data-phase=loading][data-animations=false] {animation-duration:0s;}
`;

export type ImageSettingsSection = 'settings-services' | 'settings-image-translation';

export function createImageControls(actions: {onAction(): void; onPrepare(): void; onDismiss?(): void; onInspect?(): void; onSettings?(section: ImageSettingsSection): void; translate?(source: string): string}) {
    const localize = (source: string) => actions.translate?.(source) ?? source;
    const element = document.createElement('div');
    element.className = 'fr-image-controls';
    const feedback = document.createElement('div');
    feedback.className = 'fr-image-feedback';
    const heading = document.createElement('strong');
    heading.className = 'fr-image-feedback-title';
    const status = document.createElement('div');
    status.className = 'fr-image-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const spinner = document.createElement('span');
    spinner.className = 'fr-image-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const statusText = document.createElement('span');
    status.append(spinner, statusText);
    const progressBar = document.createElement('div');
    progressBar.className = 'fr-image-progress';
    progressBar.setAttribute('role', 'progressbar');
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', '100');
    const progressFill = document.createElement('span');
    progressBar.append(progressFill);
    const row = document.createElement('div');
    row.className = 'fr-image-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fluent-read-image-translation-button';
    const prepare = document.createElement('button');
    prepare.type = 'button';
    prepare.className = 'fr-image-prepare';
    prepare.textContent = '下载语言包并翻译';
    const modelSettings = document.createElement('button');
    modelSettings.type = 'button';
    modelSettings.className = 'fr-image-model-settings';
    const serviceSettings = document.createElement('button');
    serviceSettings.type = 'button';
    serviceSettings.className = 'fr-image-service-settings';
    const errorDetails = document.createElement('details');
    errorDetails.className = 'fr-image-error-details';
    const errorSummary = document.createElement('summary');
    const errorText = document.createElement('p');
    errorDetails.append(errorSummary, errorText);
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.textContent = '文字';
    inspect.setAttribute('aria-label', '查看完整译文');
    inspect.setAttribute('aria-expanded', 'false');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'fr-image-dismiss';
    dismiss.textContent = '关闭';
    const reader = createImageTextReader(localize, () => {
        inspect.setAttribute('aria-expanded', 'false');
        if (!disposed && !inspect.hidden) inspect.focus({preventScroll: true});
        if (!disposed) refreshVisibility();
    });
    const details = reader.element;
    let hovered = true;
    let focused = false;
    function refreshVisibility() {
        element.hidden = feedback.dataset.manga === 'true' || (phase === 'translated' && !hovered && !focused && details.hidden);
    }
    let hasLines = false;
    let phase: ImageControlPhase = 'idle';
    let sourceMessage = '翻译图片';
    let progress: number | undefined;
    const refreshLanguage = () => {
        const brand = localize('流畅阅读');
        heading.textContent = `${brand} · ${localize('图片翻译')}`;
        prepare.textContent = localize('下载语言包并翻译');
        modelSettings.textContent = localize('调整本地模型');
        serviceSettings.textContent = localize('切换图片翻译服务');
        errorSummary.textContent = localize('查看错误详情');
        inspect.textContent = localize('文字');
        inspect.setAttribute('aria-label', localize('查看完整译文'));
        reader.refreshLanguage();
        dismiss.textContent = localize('关闭');
        dismiss.title = localize('关闭图片翻译提示');
        dismiss.setAttribute('aria-label', dismiss.title);
        button.textContent = localize(phase === 'loading' ? '取消' : phase === 'translated' ? '原图' : phase === 'error' && feedback.dataset.preparation === 'true' ? '关闭' : phase === 'error' ? '重试' : '翻译');
        button.title = localize(phase === 'loading' ? '取消图片翻译' : phase === 'translated' ? '恢复原图' : phase === 'error' && feedback.dataset.preparation === 'true' ? '关闭图片翻译提示' : sourceMessage);
        button.title = `${brand} · ${button.title}`;
        button.setAttribute('aria-label', button.title);
        const localizedMessage = localize(sourceMessage);
        statusText.textContent = localizedMessage + (progress === undefined ? '' : ` ${progress}%`);
        statusText.title = phase === 'error' ? localizedMessage : '';
        progressBar.setAttribute('aria-label', localize(sourceMessage));
        if (progress !== undefined) progressBar.setAttribute('aria-valuenow', String(progress));
        else progressBar.removeAttribute('aria-valuenow');
        progressFill.style.width = `${progress ?? 0}%`;
        // 百分比只更新文字，保留转圈节点，避免每次进度通知重新启动动画。
        spinner.hidden = phase !== 'loading';
    };
    let disposed = false;
    const handleClick = (event: MouseEvent) => {
        if (!event.isTrusted || disposed) return;
        event.stopPropagation();
        const target = event.target;
        if (target === button) {
            if (phase === 'error' && feedback.dataset.preparation === 'true') actions.onDismiss?.();
            else actions.onAction();
        }
        if (target === prepare) actions.onPrepare();
        if (target === modelSettings) actions.onSettings?.('settings-services');
        if (target === serviceSettings) actions.onSettings?.('settings-image-translation');
        if (target === dismiss) actions.onDismiss?.();
        if (target === inspect) {
            if (details.hidden) reader.open(); else reader.close();
            inspect.setAttribute('aria-expanded', String(!details.hidden));
            actions.onInspect?.();
            refreshVisibility();
        }
    };
    const focusIn = (event: FocusEvent) => {
        // 鼠标点击也会产生焦点；只有键盘可见焦点才在离开图片后保留入口。
        focused = (event.target as Element).matches(':focus-visible');
        refreshVisibility();
    };
    const focusOut = (event: FocusEvent) => {
        const target = event.relatedTarget as Node | null;
        focused = Boolean(target && (element.contains(target) || details.contains(target)) && (target as Element).matches(':focus-visible'));
        refreshVisibility();
    };
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    details.addEventListener('focusin', focusIn);
    details.addEventListener('focusout', focusOut);
    const isolate = (event: Event) => event.stopPropagation();
    // 只隔离本操作条的输入，绝不在 document 注册会影响宿主快捷键/滚轮的监听器。
    element.addEventListener('click', handleClick);
    row.addEventListener('click', handleClick);
    for (const event of ['pointerdown', 'keydown', 'keyup', 'wheel']) {
        element.addEventListener(event, isolate);
        row.addEventListener(event, isolate);
        feedback.addEventListener(event, isolate);
    }
    feedback.addEventListener('click', isolate);
    row.append(button, prepare, inspect, dismiss, modelSettings, serviceSettings);
    feedback.append(heading, status, progressBar, errorDetails);
    element.append(details, row);
    const update = (next: ImageControlPhase, message: string, options: {prepare?: boolean; animations?: boolean; progress?: number; quiet?: boolean; queued?: boolean; modelSettings?: boolean; serviceSettings?: boolean; errorDetails?: string} = {}) => {
        phase = next;
        element.dataset.phase = next;
        button.dataset.phase = next;
        feedback.dataset.phase = next;
        feedback.dataset.manga = String(options.quiet === true);
        feedback.dataset.queued = String(next === 'loading' && options.queued === true);
        heading.hidden = next !== 'error' || options.quiet === true;
        feedback.dataset.preparation = String(next === 'error' && options.prepare === true);
        element.dataset.preparation = feedback.dataset.preparation;
        // 加载旋转属于任务状态反馈，独立于装饰动效开关；系统减少动态效果偏好由 CSS 保留。
        spinner.dataset.animated = String(next === 'loading');
        sourceMessage = message;
        progress = next === 'loading' ? normalizeImageProgress(options.progress) : undefined;
        refreshLanguage();
        status.hidden = next === 'idle' || next === 'translated';
        feedback.hidden = options.quiet === true ? next !== 'loading' && next !== 'error' : status.hidden;
        progressBar.hidden = options.quiet !== true || progress === undefined;
        refreshVisibility();
        modelSettings.hidden = next !== 'error' || options.modelSettings !== true;
        serviceSettings.hidden = next !== 'error' || options.serviceSettings !== true;
        feedback.dataset.recovery = String(!modelSettings.hidden);
        errorDetails.hidden = next !== 'error' || !options.errorDetails;
        errorDetails.open = false;
        errorText.textContent = options.errorDetails || '';
        element.setAttribute('aria-busy', String(next === 'loading'));
        element.dataset.animations = String(options.animations !== false);
        feedback.dataset.animations = element.dataset.animations;
        prepare.hidden = next !== 'error' || !options.prepare;
        dismiss.hidden = next !== 'error' || options.prepare === true;
        const feedbackOwnsActions = next === 'error' || (next === 'loading' && options.queued === true);
        const actionsOwner = feedbackOwnsActions ? feedback : element;
        // 进度更新会频繁刷新状态；仅在状态容器变化时移动操作条，避免重挂载打断悬停与焦点。
        if (row.parentElement !== actionsOwner) actionsOwner.insertBefore(row, feedbackOwnsActions ? errorDetails : null);
        inspect.hidden = next !== 'translated' || !hasLines;
        if (next !== 'translated') {
            details.hidden = true;
            inspect.setAttribute('aria-expanded', 'false');
        }
    };
    update('idle', '翻译图片');
    return {
        element, feedback, button, status, spinner, dismiss, update, refreshLanguage, reader: details,
        setHovered(value: boolean) {hovered = value; refreshVisibility();},
        hideReader() {details.hidden = true; inspect.setAttribute('aria-expanded', 'false'); refreshVisibility();},
        setLines(lines: ImageReaderLine[]) {
            hasLines = lines.length > 0;
            reader.setLines(lines);
            inspect.hidden = phase !== 'translated' || lines.length === 0;
        },
        dispose() {
            disposed = true;
            reader.dispose();
            element.removeEventListener('focusin', focusIn);
            element.removeEventListener('focusout', focusOut);
            details.removeEventListener('focusin', focusIn);
            details.removeEventListener('focusout', focusOut);
            element.removeEventListener('click', handleClick);
            row.removeEventListener('click', handleClick);
            for (const event of ['pointerdown', 'keydown', 'keyup', 'wheel']) {
                element.removeEventListener(event, isolate);
                row.removeEventListener(event, isolate);
                feedback.removeEventListener(event, isolate);
            }
            feedback.removeEventListener('click', isolate);
            element.remove();
            feedback.remove();
        },
    };
}

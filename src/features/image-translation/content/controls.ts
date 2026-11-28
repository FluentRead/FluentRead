/**
 * @file src/features/image-translation/content/controls.ts
 * 失败层级：错误时仅突出语言准备、模型、服务或重试中的一个主操作，其余动作放入默认收起的原生详情；状态变化仍由同一操作条承接。
 * 文件职责：创建图片翻译的极简纯图标角标操作条与居中毛玻璃旋转指示器，支持单图反馈、不遮挡阅读的漫画模式与单页悬停微胶囊，支持取消、重试、单页原图切换与重译以及首次语言准备和设置导航。
 * 主要内容：单图提供左下角无框低饱和图标入口、居中纯图标毛玻璃旋转加载球（悬停切换取消图标，首次下载资源时平滑展开百分比胶囊）、纯图标已译微胶囊与全文详情；支持按场景控制是否在文案旁显示百分比，避免常规翻译阶段文字抖动；缺资源回退的已有译文在状态探测或失败时保留可见主入口和展开面板，普通加载与错误仍默认隐藏旧阅读器；文字面板记录实际触发入口并按焦点所有权归还，入口消失时仅回退到同一结果的可见文字按钮，品牌提示沿用注入的界面本地化端口；漫画处理时在图片可见边缘延迟显示同质感极简圆环，暂停会话后的单页排队可取消，失败时在同一边缘提供紧凑的重试、详情及设置入口，恢复动作先于独立滚动的长错误详情，完成页在未悬停或聚焦时完全隐藏，悬停或键盘聚焦才按需显现轻量单页原图/译图切换与重新翻译微胶囊，不展开常驻阅读面板；任务旋转独立于装饰动画开关并保留系统减少动态效果偏好。
 * 模块边界：仅操作所属 Shadow DOM，不读取配置、不访问网络、不持有图片请求；业务动作及生命周期由 content/runtime 注入。
 */
import {createImageTextReader, IMAGE_READER_CSS, type ImageReaderLine, type ImageReaderLanguages} from './textReader';
import {normalizeImageProgress} from '../progress';
import imageControlsCss from '../ui/image-controls.css?inline';
import brandIcon from '../../../../public/icon/32.png?inline';

export type ImageControlPhase = 'idle' | 'loading' | 'translated' | 'error';
// 基础颜色和字体由 reader CSS 在所属 Shadow UI 内统一声明，避免重复打包及宿主变量串入。
export const IMAGE_CONTROLS_CSS = IMAGE_READER_CSS
    + `.fr-image-controls,.fr-image-feedback{--fr-image-icon:url("${brandIcon}")}` + imageControlsCss;

export type ImageSettingsSection = 'settings-services' | 'settings-image-translation';

/** 只在入口拥有完整焦点链或页面没有焦点时转移，避免抢走其他控件的焦点。 */
function mayFocusReader(trigger: HTMLElement): boolean {
    const doc = trigger.ownerDocument;
    if (!trigger.isConnected) return false;
    const source = trigger.getRootNode() as Document | ShadowRoot;
    const active = doc.activeElement;
    const noFocus = !!active && (active === doc.body || active === doc.documentElement)
        && !active.matches(':focus-within') && (source === doc || source.activeElement === null);
    let current: Node = trigger, owned = true;
    for (;;) {
        const root = current.getRootNode() as Document | ShadowRoot;
        if (root.activeElement !== current) owned = false;
        if (root === doc) return owned || noFocus;
        current = (root as ShadowRoot).host;
    }
}

export function createImageControls(actions: {onAction(): void; onPrepare(): void; onRetranslate?(): void; onDismiss?(): void; onInspect?(): void; onSettings?(section: ImageSettingsSection): void; translate?(source: string): string; onWarning?(event: MouseEvent): void}) {
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
    const warningButton = document.createElement('button');
    warningButton.type = 'button';warningButton.className = 'fr-image-warning-button';warningButton.hidden = true;
    const progressBar = document.createElement('div');
    progressBar.className = 'fr-image-progress';
    progressBar.setAttribute('role', 'progressbar');
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', '100');
    const progressFill = document.createElement('span');
    progressBar.append(progressFill);
    const row = document.createElement('div');
    row.className = 'fr-image-actions';
    const more = document.createElement('details');
    more.className = 'fr-image-more';
    const moreSummary = document.createElement('summary');
    const moreActions = document.createElement('div');
    more.append(moreSummary, moreActions);
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
    inspect.className = 'fr-image-inspect';
    inspect.textContent = '文字';
    inspect.setAttribute('aria-label', '查看完整译文');
    inspect.setAttribute('aria-expanded', 'false');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'fr-image-dismiss';
    dismiss.textContent = '关闭';
    const retranslate = document.createElement('button');
    retranslate.type = 'button';
    retranslate.className = 'fr-image-retranslate';
    retranslate.hidden = true;
    let readerTrigger: HTMLElement | null = null;
    let returningFocus = false;
    const reader = createImageTextReader(localize, ownedFocus => {
        inspect.setAttribute('aria-expanded', 'false');
        const trigger = readerTrigger;readerTrigger = null;
        const readable = canRead();
        const canInspect = readable && !inspect.hidden
            && feedback.dataset.manga !== 'true' && inspect.isConnected;
        const available = readable && trigger === warningButton && !feedback.hidden && !warningButton.hidden && warningButton.isConnected
            ? warningButton : trigger && canInspect ? inspect : null;
        if (!disposed && ownedFocus && available) {
            // 文字入口与面板同属操作条；仅当入口在操作条内时才先显示祖先，避免焦点留在已隐藏容器内。
            returningFocus = available === inspect && element.contains(inspect);
            if (returningFocus) {element.hidden = false;focused = true;}
            // focus() 会同步派发 focusout/focusin；归还期间二者都不能隐藏目标祖先。
            try {available.focus({preventScroll: true});}
            finally {returningFocus = false;}
        }
        if (!disposed) refreshVisibility();
    });
    const details = reader.element;
    let hovered = true;
    let focused = false;
    function refreshVisibility() {
        const mangaActions = element.dataset.mangaActions === 'true';
        element.hidden = (feedback.dataset.manga === 'true' && !mangaActions)
            || (phase === 'loading' && details.hidden)
            || ((phase === 'translated' || mangaActions) && !hovered && !focused && details.hidden);
    }
    let hasLines = false;
    let phase: ImageControlPhase = 'idle';
    let retainedReading = false;
    function canRead(): boolean { return hasLines && (phase === 'translated' || retainedReading); }
    let sourceMessage = '翻译图片';
    let progress: number | undefined;
    let showPercent = true;
    const openReader = (trigger: HTMLElement) => {
        if (!canRead()) return;
        const takeFocus = mayFocusReader(trigger);
        readerTrigger = trigger;
        // warning 位于独立 feedback 中；隐藏的操作条会让浏览器忽略面板 focus。
        element.hidden = false;
        reader.open(takeFocus);
        inspect.setAttribute('aria-expanded', 'true');
        actions.onInspect?.();
        refreshVisibility();
    };
    const refreshLanguage = () => {
        const brand = localize('流畅阅读');
        heading.textContent = `${brand} · ${localize('图片翻译')}`;
        prepare.textContent = localize('下载语言包并翻译');
        modelSettings.textContent = localize('调整本地模型');
        serviceSettings.textContent = localize('切换图片翻译服务');
        errorSummary.textContent = localize('查看错误详情');
        moreSummary.textContent = localize('更多操作');
        inspect.textContent = localize('文字');
        inspect.title = localize('查看完整译文');
        inspect.setAttribute('aria-label', inspect.title);
        reader.refreshLanguage();
        dismiss.textContent = localize('关闭');
        dismiss.title = localize('关闭图片翻译提示');
        dismiss.setAttribute('aria-label', dismiss.title);
        const manga = feedback.dataset.manga === 'true';
        const mangaActions = element.dataset.mangaActions === 'true';
        const mangaOriginal = mangaActions && element.dataset.mangaOriginal === 'true';
        const originalRetained = !manga && sourceMessage === '已识别文字，原图未改动';
        const dismissAction = originalRetained || (phase === 'error' && feedback.dataset.preparation === 'true');
        button.textContent = localize(mangaOriginal ? '译图' : dismissAction ? '关闭' : phase === 'loading' ? '取消' : phase === 'translated' ? '原图' : phase === 'error' ? '重试' : '翻译');
        const actionTitle = mangaOriginal ? localize('查看译图') : dismissAction ? dismiss.title : localize(phase === 'loading' ? '取消图片翻译' : phase === 'translated' ? '恢复原图' : sourceMessage);
        button.title = `${brand} · ${actionTitle}`;
        button.setAttribute('aria-label', button.title);
        retranslate.textContent = localize('重新翻译');
        retranslate.title = `${brand} · ${localize('重新翻译')}`;
        retranslate.setAttribute('aria-label', retranslate.title);
        const localizedMessage = localize(sourceMessage);
        warningButton.textContent = manga ? localize('未绘制') : originalRetained ? inspect.textContent : '!';
        warningButton.title = manga || sourceMessage === '部分译文未绘制，请查看图片文字'
            ? localizedMessage : `${localizedMessage} · ${localize('查看图片文字')}`;
        warningButton.setAttribute('aria-label', warningButton.title);
        statusText.textContent = (feedback.dataset.warning === 'true' && feedback.dataset.warningAction !== 'true'
            ? localize('已识别') : localizedMessage) + (showPercent && progress !== undefined ? ` ${progress}%` : '');
        if (feedback.dataset.warning === 'true') status.setAttribute('aria-label', localizedMessage);else status.removeAttribute('aria-label');
        statusText.title = phase === 'error' || feedback.dataset.warning === 'true' ? localizedMessage : '';
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
        if (target === retranslate) actions.onRetranslate?.();
        if (target === inspect) {
            if (details.hidden) openReader(inspect);
            else {reader.close();actions.onInspect?.();refreshVisibility();}
        }
    };
    const focusIn = (event: FocusEvent) => {
        // 鼠标点击也会产生焦点；只有键盘可见焦点才在离开图片后保留入口。
        focused = returningFocus || (event.target as Element).matches(':focus-visible');
        refreshVisibility();
    };
    const focusOut = (event: FocusEvent) => {
        const target = event.relatedTarget as Node | null;
        focused = Boolean(target && (element.contains(target) || details.contains(target))
            && (returningFocus || (target as Element).matches(':focus-visible')));
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
    for (const event of ['pointerdown', 'keydown', 'keyup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel']) {
        element.addEventListener(event, isolate);
        row.addEventListener(event, isolate);
        feedback.addEventListener(event, isolate);
    }
    const handleWarning = (event: MouseEvent) => {
        if (!event.isTrusted || disposed) return;
        event.stopPropagation();
        if (feedback.dataset.manga === 'true') actions.onWarning?.(event);
        else if (hasLines && details.hidden) openReader(warningButton);
    };
    warningButton.addEventListener('click', handleWarning);
    feedback.addEventListener('click', isolate);
    const actionButtons = [button, prepare, inspect, dismiss, modelSettings, serviceSettings];
    row.append(...actionButtons, more);
    feedback.append(heading, status, progressBar, errorDetails);
    element.append(details, row);
    const update = (next: ImageControlPhase, message: string, options: {prepare?: boolean; animations?: boolean; progress?: number; showPercent?: boolean; quiet?: boolean; warning?: boolean; warningAction?: boolean; queued?: boolean; modelSettings?: boolean; serviceSettings?: boolean; errorDetails?: string; retainedReading?: boolean; mangaActions?: boolean; mangaOriginalShown?: boolean} = {}) => {
        phase = next;
        retainedReading = options.retainedReading === true && (next === 'loading' || next === 'error');
        const mangaActions = options.quiet === true && next === 'translated' && options.mangaActions === true;
        const mangaOriginalShown = mangaActions && options.mangaOriginalShown === true;
        element.dataset.phase = next;
        element.dataset.mangaActions = String(mangaActions);
        element.dataset.mangaOriginal = String(mangaOriginalShown);
        button.dataset.phase = next;
        feedback.dataset.phase = next;
        feedback.dataset.manga = String(options.quiet === true);
        feedback.dataset.queued = String(next === 'loading' && options.queued === true);
        feedback.dataset.warning = String(next === 'translated' && options.warning === true);
        feedback.dataset.warningAction = String(options.warningAction === true);
        heading.hidden = next !== 'error' || options.quiet === true;
        feedback.dataset.preparation = String(next === 'error' && options.prepare === true);
        element.dataset.preparation = feedback.dataset.preparation;
        // 加载旋转属于任务状态反馈，独立于装饰动效开关；系统减少动态效果偏好由 CSS 保留。
        spinner.dataset.animated = String(next === 'loading');
        sourceMessage = message;
        progress = next === 'loading' ? normalizeImageProgress(options.progress) : undefined;
        showPercent = next === 'loading' && options.showPercent !== false;
        feedback.dataset.compact = String(next === 'loading' && !showPercent && options.queued !== true && !canRead());
        refreshLanguage();
        warningButton.hidden = !(feedback.dataset.warning === 'true' && options.warningAction === true);
        if (warningButton.hidden) warningButton.remove();else if (warningButton.parentElement !== feedback) feedback.append(warningButton);
        retranslate.hidden = !mangaActions;
        if (retranslate.hidden) retranslate.remove();else if (retranslate.parentElement !== row) row.insertBefore(retranslate, more);
        status.hidden = next === 'idle' || (next === 'translated' && (feedback.dataset.warning !== 'true' || !warningButton.hidden));
        feedback.hidden = feedback.dataset.warning === 'true' ? false : options.quiet === true ? next !== 'loading' && next !== 'error' : status.hidden;
        progressBar.hidden = next !== 'loading' || progress === undefined;
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
        const feedbackOwnsActions = next === 'error' || (next === 'loading' && (options.quiet !== true || options.queued === true));
        const actionsOwner = feedbackOwnsActions ? feedback : element;
        // 进度更新会频繁刷新状态；仅在状态容器变化时移动操作条，避免重挂载打断悬停与焦点。
        if (row.parentElement !== actionsOwner) actionsOwner.insertBefore(row, feedbackOwnsActions ? errorDetails : null);
        inspect.hidden = !canRead() || feedback.dataset.manga === 'true';
        if (next === 'error') {
            const primary = !prepare.hidden ? prepare : !modelSettings.hidden ? modelSettings : !serviceSettings.hidden ? serviceSettings : button;
            for (const control of actionButtons) {
                const owner = control === primary || (control === inspect && canRead()) ? row : moreActions;
                if (control.parentElement !== owner) owner.append(control);
            }
            more.hidden = !actionButtons.some(control => control !== primary && !control.hidden);
            more.open = false;
            row.insertBefore(primary, more);
            if (canRead()) row.insertBefore(inspect, more);
        } else {
            if (moreActions.childElementCount) for (const control of actionButtons) row.insertBefore(control, more);
            more.hidden = true;
        }
        if (!canRead()) {
            details.hidden = true;
            readerTrigger = null;
            inspect.setAttribute('aria-expanded', 'false');
        }
    };
    update('idle', '翻译图片');
    return {
        element, feedback, button, status, spinner, dismiss, update, refreshLanguage, reader: details,
        setHovered(value: boolean) {hovered = value; refreshVisibility();},
        hideReader() {details.hidden = true; readerTrigger = null; inspect.setAttribute('aria-expanded', 'false'); refreshVisibility();},
        setLines(lines: ImageReaderLine[], languages?: ImageReaderLanguages) {
            hasLines = lines.length > 0;
            reader.setLines(lines, languages);
            inspect.hidden = !canRead() || feedback.dataset.manga === 'true';
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
            for (const event of ['pointerdown', 'keydown', 'keyup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel']) {
                element.removeEventListener(event, isolate);
                row.removeEventListener(event, isolate);
                feedback.removeEventListener(event, isolate);
            }
            warningButton.removeEventListener('click', handleWarning);
            feedback.removeEventListener('click', isolate);
            element.remove();
            feedback.remove();
        },
    };
}

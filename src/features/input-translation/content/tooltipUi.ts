/**
 * @file src/features/input-translation/content/tooltipUi.ts
 *
 * 文件职责：封装输入框翻译封闭 Shadow Root 状态提示条的创建、视口定位、rAF 滚动追踪与淡出清理生命周期。
 * 主要内容：导出 createInputTranslationTooltipController，统一管理翻译中/成功/失败提示、撤销/重试/关闭动作按钮、只读译文预览区及退场淡出队列。
 * 模块边界：仅负责提示 UI 的渲染、定位和定时清理，不直接发起翻译请求或修改输入框文本，所有请求代次与启用校验由调用方注入。
 */

import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';
import {normalizeUiLanguage, translateLegacyText} from '@/src/core/i18n';
import {clampToVisualViewport, getSafeVisualViewportRect} from '@/src/platform/dom/visualViewport';
import type {InputTranslationContentDependencies} from './configKey';

function getTooltipIcon(type: 'translating' | 'success' | 'error'): string {
    const icons = {
        translating: '•',
        success: '✓',
        error: '!',
    };
    return icons[type];
}

function buildInputTooltipCss(interactive: boolean): string {
    return `:host{all:initial!important;display:block!important;position:relative!important;width:0!important;height:0!important;overflow:visible!important}html,body{width:0!important;height:0!important;margin:0!important;padding:0!important;overflow:visible!important}.fluent-input-tooltip{position:fixed;opacity:0;transform:translateY(3px);box-sizing:border-box;background:rgba(17,24,39,.88);color:#fff;padding:8px 12px;border:0;border-radius:8px;font:500 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:normal;max-width:min(360px,calc(100vw - 24px));overflow-y:auto;overscroll-behavior:contain;overflow-wrap:anywhere;z-index:2147483647;pointer-events: ${interactive ? 'auto' : 'none'};transition:opacity .2s ease,transform .2s ease;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(15,23,42,.2)}.fluent-input-tooltip.show{opacity:1;transform:translateY(0)}.fluent-input-tooltip.hide{opacity:0;transform:translateY(-5px)}.fluent-input-tooltip.translating{background:rgba(29,78,216,.96)}.fluent-input-tooltip.success{background:rgba(22,101,52,.96)}.fluent-input-tooltip.error{background:rgba(185,28,28,.96)}.fluent-input-tooltip textarea{font:inherit}@media(any-pointer:coarse){.fluent-input-tooltip.has-actions{font-size:14px}.fluent-input-tooltip button{min-width:44px;min-height:44px;touch-action:manipulation}.fluent-input-tooltip textarea{font-size:16px}}`;
}

export interface InputTranslationTooltipOptions {
    deps: InputTranslationContentDependencies;
    later: (callback: () => void, delay: number) => void;
    isEnabled: () => boolean;
    getActiveRequestId: () => number;
    onTooltipDetached: () => void;
}

export interface InputTranslationTooltipController {
    remove: (ownerRequestId?: number, immediately?: boolean) => void;
    clearFading: () => void;
    dismissLater: (requestId: number) => void;
    show: (
        element: HTMLElement,
        message: string,
        type: 'translating' | 'success' | 'error',
        requestId: number,
        signal: AbortSignal,
        restore?: {label: string; onRestore: () => Promise<void>},
        previewText?: string,
    ) => Promise<HTMLElement | null>;
}

export function createInputTranslationTooltipController(
    options: InputTranslationTooltipOptions,
): InputTranslationTooltipController {
    const {deps, later, isEnabled, getActiveRequestId, onTooltipDetached} = options;
    const rootDocument = deps.document;
    const createUi = deps.createUi;
    const logger = deps.logger;
    let inputTooltipUi: ShadowRootContentScriptUi<HTMLElement> | null = null;
    let inputTooltipOwnerRequestId: number | null = null;
    let tooltipRevision = 0;
    let removeTooltipPositionListeners: (() => void) | null = null;
    const fadingUis = new Set<ShadowRootContentScriptUi<HTMLElement>>();

    const remove = (ownerRequestId?: number, immediately = false): void => {
        if (ownerRequestId !== undefined && inputTooltipOwnerRequestId !== ownerRequestId) return;
        tooltipRevision += 1;
        removeTooltipPositionListeners?.();
        removeTooltipPositionListeners = null;

        const ui = inputTooltipUi;
        const existing = ui?.mounted;
        inputTooltipUi = null;
        inputTooltipOwnerRequestId = null;
        onTooltipDetached();
        if (!ui) return;

        if (immediately || !existing || !deps.config.animations) {
            ui.remove();
            return;
        }

        existing.classList.add('hide');
        fadingUis.add(ui);
        later(() => { fadingUis.delete(ui); ui.remove(); }, 300);
    };

    const clearFading = (): void => {
        fadingUis.forEach(ui => ui.remove());
        fadingUis.clear();
    };

    const dismissLater = (requestId: number): void => {
        // UI 创建的异步等待可能跨越取消；迟到 continuation 不再注册计时器。
        if (requestId === getActiveRequestId()) later(() => remove(requestId), 8000);
    };

    const createTooltip = async (
        element: HTMLElement,
        message: string,
        type: 'translating' | 'success' | 'error',
        requestId: number,
        signal: AbortSignal,
        restore?: {label: string; onRestore: () => Promise<void>},
        previewText?: string,
    ): Promise<HTMLElement | null> => {
        remove();
        inputTooltipOwnerRequestId = requestId;
        const revision = tooltipRevision;

        const ui = await createUi<HTMLElement>(deps.context, {
            name: 'fluent-read-input-tooltip-ui',
            position: 'overlay',
            alignment: 'top-left',
            zIndex: 2_147_483_647,
            mode: 'closed',
            inheritStyles: false,
            css: buildInputTooltipCss(Boolean(restore || previewText)),
            onMount(container) {
                const tooltip = rootDocument.createElement('div');
                tooltip.className = `fluent-input-tooltip ${type}${restore ? ' has-actions' : ''}`;
                tooltip.id = 'fluent-input-translation-tooltip';
                tooltip.setAttribute('role', 'status');
                tooltip.setAttribute('aria-live', 'polite');
                tooltip.textContent = `${getTooltipIcon(type)} ${translateLegacyText(
                    message,
                    normalizeUiLanguage(deps.config.uiLanguage),
                )}`;
                tooltip.style.transform = 'translateY(3px)';
                tooltip.style.opacity = deps.config.animations ? '0' : '1';
                container.appendChild(tooltip);
                if (restore) {
                    const restoreButton = rootDocument.createElement('button');
                    restoreButton.type = 'button';
                    restoreButton.textContent = translateLegacyText(
                        restore.label,
                        normalizeUiLanguage(deps.config.uiLanguage),
                    );
                    restoreButton.style.cssText = 'margin-left:8px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer;';
                    restoreButton.addEventListener?.('mousedown', (event: Event) => event.preventDefault());
                    restoreButton.addEventListener?.('click', (event: Event) => {
                        if (!(event as Event & {isTrusted?: boolean}).isTrusted) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const reportFailure = (error: unknown) => {
                            // 成功提示可比原翻译请求存活更久；恢复等待结束后也须复验当前实例的代次。
                            if (!signal.aborted && requestId === getActiveRequestId()) logger.error('输入框翻译操作失败:', error);
                        };
                        void restore.onRestore().catch(reportFailure);
                    });
                    tooltip.appendChild(restoreButton);
                }
                if (previewText) {
                    tooltip.style.width = '320px';
                    const preview = rootDocument.createElement('textarea');
                    preview.readOnly = true;
                    preview.value = previewText;
                    preview.setAttribute('aria-label', translateLegacyText('译文', normalizeUiLanguage(deps.config.uiLanguage)));
                    preview.style.cssText = 'display:block;box-sizing:border-box;width:100%;min-width:0;max-width:100%;height:5em;margin-top:8px;padding:6px;border:1px solid rgba(255,255,255,.4);border-radius:4px;background:transparent;color:inherit;resize:vertical;';
                    tooltip.appendChild(preview);
                }
                return tooltip;
            },
        });

        if (
            signal.aborted
            || requestId !== getActiveRequestId()
            || revision !== tooltipRevision
            || inputTooltipOwnerRequestId !== requestId
            || !isEnabled()
        ) {
            ui.remove();
            return null;
        }

        inputTooltipUi = ui;
        ui.shadowHost.id = 'fluent-input-translation-tooltip-host';
        ui.shadowHost.setAttribute('data-fluent-read-ui', 'input-tooltip');
        ui.mount();

        const tooltip = ui.mounted!;
        const position = () => {
            const view = rootDocument.defaultView;
            const rect = element.getBoundingClientRect();
            const viewport = view ? getSafeVisualViewportRect(view)
                : {left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768};
            // 高度不足84时先回收留白；可用高度至少44时仍给完整44按钮留出内容空间。
            // 长状态文案与预览继续只滚动自己的提示，不推动宿主页或编辑器。
            const verticalGap = Math.max(0, Math.min(12, (viewport.height - 60) / 2));
            const paddingBlock = Math.max(0, Math.min(8, (viewport.height - 44) / 2));
            tooltip.style.paddingBlock = `${paddingBlock}px`;
            tooltip.style.maxWidth = `${Math.max(1, Math.min(360, viewport.width - 24))}px`;
            tooltip.style.maxHeight = `${Math.max(1, viewport.height - verticalGap * 2)}px`;
            const bounds = tooltip.getBoundingClientRect();
            const width = bounds.width || 120;
            const height = bounds.height || 44;
            const point = {
                left: rect.left + (rect.width - width) / 2,
                top: rect.bottom + height + verticalGap <= viewport.bottom
                    ? rect.bottom + verticalGap : (rect.top || 0) - height - verticalGap,
            };
            const placement = clampToVisualViewport(point, {width, height}, viewport);
            // 通用夹边的gap同时影响两轴；横向仍保留原12px，仅纵向使用回收后的留白。
            const verticalPlacement = clampToVisualViewport(point, {width, height}, viewport, verticalGap);
            tooltip.style.left = `${placement.left}px`;
            tooltip.style.top = `${verticalPlacement.top}px`;
        };
        position();
        const view = rootDocument.defaultView;
        let positionFrame: number | undefined;
        let positionActive = true;
        const schedulePosition = () => {
            if (!positionActive || positionFrame !== undefined) return;
            // 小型 DOM 适配器可不提供绘制时钟；真实页面把同帧多种视口事件合并成一次几何读取。
            if (typeof view?.requestAnimationFrame !== 'function') { position(); return; }
            positionFrame = view.requestAnimationFrame(() => {
                positionFrame = undefined;
                if (positionActive && inputTooltipUi === ui) position();
            });
        };
        view?.addEventListener?.('scroll', schedulePosition, {capture: true, passive: true});
        view?.addEventListener?.('resize', schedulePosition, {passive: true});
        const visualViewport = view?.visualViewport;
        visualViewport?.addEventListener('resize', schedulePosition);
        visualViewport?.addEventListener('scroll', schedulePosition, {passive: true});
        removeTooltipPositionListeners = () => {
            positionActive = false;
            if (positionFrame !== undefined) view?.cancelAnimationFrame(positionFrame);
            positionFrame = undefined;
            view?.removeEventListener?.('scroll', schedulePosition, true);
            view?.removeEventListener?.('resize', schedulePosition);
            visualViewport?.removeEventListener('resize', schedulePosition);
            visualViewport?.removeEventListener('scroll', schedulePosition);
        };
        if (!deps.config.animations) {
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'translateY(0)';
        } else {
            // 动画由 show/hide 类控制，清除初始行内值，避免行内 opacity:0 永久压住成功提示。
            tooltip.style.opacity = '';
            tooltip.style.transform = '';
            later(() => tooltip.classList.add('show'), 10);
        }

        return tooltip;
    };

    // 提示 UI 故障不能阻断翻译或造成未处理拒绝；临时节点仍由请求与状态 revision 共同拥有。
    const show: InputTranslationTooltipController['show'] = async (...args) => {
        try { return await createTooltip(...args); }
        catch (error) {
            if (!args[4].aborted) logger.error('输入框翻译提示创建失败:', error);
            return null;
        }
    };

    return {remove, clearFading, dismissLater, show};
}

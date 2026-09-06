/**
 * @file src/features/input-translation/content/index.ts
 * 文件职责：实现网页输入框翻译 feature 的可注入生命周期，根据配置识别三连触发符、冻结请求所有权、调用后台并把译文安全提交回原控件。
 * 主要内容：定义配置、依赖和 feature 契约，提供启用判断、配置键和 input/change 事件写回，创建 closed Shadow tooltip 展示翻译中/成功/失败，并防止元素或配置变化后的迟到提交。
 * 模块边界：本文件拥有内容页事件与临时 UI，不直接调用 provider 或全局 browser API；sendMessage、Shadow UI、站点禁用和 generation 均由 composition root 注入，输入纯算法来自 inputBox.ts。
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import {normalizeUiLanguage, translateLegacyText} from '@/src/core/i18n';
import {
    canCommitInputBoxTranslation,
    getDeepActiveElement,
    getInputBoxText,
    getInputBoxValueSnapshot,
    isInputElement,
    matchesInputBoxTrigger,
    removeTriggerSymbols,
    type InputBoxTrigger,
} from './inputBox';

export interface InputTranslationContentConfig {
    on?: boolean;
    uiLanguage?: string;
    inputBoxTranslationTrigger: string;
    inputBoxTranslationTarget: string;
    animations?: boolean;
}

export interface InputTranslationContentDependencies {
    context: ContentScriptContext;
    config: InputTranslationContentConfig;
    isSiteDisabled: () => boolean;
    readConfigGeneration: () => number;
    sendMessage: (message: unknown) => Promise<unknown>;
    document: Document;
    createUi: <T extends HTMLElement>(
        context: ContentScriptContext,
        options: {
            name: string;
            position: 'overlay';
            alignment: 'top-left';
            zIndex: number;
            mode: 'closed';
            inheritStyles: false;
            css: string;
            onMount: (container: HTMLElement) => T;
        },
    ) => Promise<ShadowRootContentScriptUi<T>>;
    logger: Pick<Console, 'error'>;
}

export interface InputTranslationContentFeature {
    mount: (signal: AbortSignal) => void;
    invalidate: () => void;
}

export function inputBoxTranslationConfigKey(value: InputTranslationContentConfig): string {
    return JSON.stringify([
        value.on,
        value.inputBoxTranslationTrigger,
        value.inputBoxTranslationTarget,
    ]);
}

export function isInputBoxTranslationEnabled(
    config: Pick<InputTranslationContentConfig, 'on' | 'inputBoxTranslationTrigger'>,
    isSiteDisabled = false,
): boolean {
    return !isSiteDisabled
        && config.on !== false
        && config.inputBoxTranslationTrigger !== 'disabled';
}

export function setInputBoxText(element: HTMLElement, text: string): void {
    // 写回本身也是安全边界：异步期间页面可能把普通输入框改成 password，
    // 或把 plaintext-only 编辑区升级成富文本。直接调用者也不能绕过资格判定。
    if (!isInputElement(element)) return;
    const tagName = element.tagName.toLowerCase();

    if (tagName === 'input' || tagName === 'textarea') {
        const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
        inputElement.value = text;
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }

    element.innerText = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

function getTooltipIcon(type: 'translating' | 'success' | 'error'): string {
    const icons = {
        translating: '•',
        success: '✓',
        error: '!',
    };
    return icons[type];
}

async function translateWithMicrosoft(
    sendMessage: (message: unknown) => Promise<unknown>,
    text: string,
    targetLang: string,
): Promise<string> {
    const result = await sendMessage({
        type: 'inputBoxTranslation',
        text,
        targetLang,
    }) as { success?: boolean; translatedText?: string; error?: string } | undefined;

    if (result?.success) return result.translatedText || '';
    throw new Error(result?.error || '微软翻译失败');
}

export function createInputTranslationContentFeature(
    deps: InputTranslationContentDependencies,
): InputTranslationContentFeature {
    const rootDocument = deps.document;
    const createUi = deps.createUi;
    const logger = deps.logger;
    let inputTooltipUi: ShadowRootContentScriptUi<HTMLElement> | null = null;
    let inputTooltipOwnerRequestId: number | null = null;
    let activeInputTranslationRequestId = 0;
    let activeInputTranslationElement: HTMLElement | null = null;

    const isEnabled = () => isInputBoxTranslationEnabled(deps.config, deps.isSiteDisabled());

    const removeExistingTooltip = (ownerRequestId?: number): void => {
        if (ownerRequestId !== undefined && inputTooltipOwnerRequestId !== ownerRequestId) return;

        const ui = inputTooltipUi;
        const existing = ui?.mounted;
        inputTooltipUi = null;
        inputTooltipOwnerRequestId = null;
        if (!ui) return;

        if (!existing || !deps.config.animations) {
            ui.remove();
            return;
        }

        existing.classList.add('hide');
        setTimeout(() => ui.remove(), 300);
    };

    const invalidate = (): void => {
        activeInputTranslationRequestId += 1;
        activeInputTranslationElement?.classList.remove('fluent-input-translating');
        activeInputTranslationElement?.classList.remove('fluent-input-success', 'fluent-input-error');
        activeInputTranslationElement = null;
        removeExistingTooltip();
    };

    const addInputBoxAnimation = (
        element: HTMLElement,
        animationType: 'translating' | 'success' | 'error',
        ownerRequestId: number,
    ): void => {
        if (!deps.config.animations) return;

        element.classList.remove('fluent-input-translating', 'fluent-input-success', 'fluent-input-error');
        element.classList.add(`fluent-input-${animationType}`);

        if (animationType !== 'translating') {
            setTimeout(() => {
                if (ownerRequestId !== activeInputTranslationRequestId) return;
                element.classList.remove(`fluent-input-${animationType}`);
            }, animationType === 'success' ? 1000 : 600);
        }
    };

    const createTranslationTooltip = async (
        element: HTMLElement,
        message: string,
        type: 'translating' | 'success' | 'error',
        requestId: number,
        signal: AbortSignal,
    ): Promise<HTMLElement | null> => {
        removeExistingTooltip();
        inputTooltipOwnerRequestId = requestId;
        const rect = element.getBoundingClientRect();

        const ui = await createUi<HTMLElement>(deps.context, {
            name: 'fluent-read-input-tooltip-ui',
            position: 'overlay',
            alignment: 'top-left',
            zIndex: 2_147_483_647,
            mode: 'closed',
            inheritStyles: false,
            css: `
                :host {
                    all: initial !important;
                    display: block !important;
                    position: relative !important;
                    width: 0 !important;
                    height: 0 !important;
                    overflow: visible !important;
                }
                html, body {
                    width: 0 !important;
                    height: 0 !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    overflow: visible !important;
                }
                .fluent-input-tooltip {
                    position: fixed;
                    box-sizing: border-box;
                    background: rgba(17, 24, 39, 0.88);
                    color: #fff;
                    padding: 8px 12px;
                    border: 0;
                    border-radius: 8px;
                    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    white-space: nowrap;
                    z-index: 2147483647;
                    pointer-events: none;
                    transition: opacity 0.2s ease, transform 0.2s ease;
                    backdrop-filter: blur(8px);
                    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.2);
                }
                .fluent-input-tooltip.show { opacity: 1; transform: translateX(-50%) translateY(0); }
                .fluent-input-tooltip.hide { opacity: 0; transform: translateX(-50%) translateY(-5px); }
                .fluent-input-tooltip.translating { background: rgba(59, 130, 246, 0.9); }
                .fluent-input-tooltip.success { background: rgba(34, 197, 94, 0.9); }
                .fluent-input-tooltip.error { background: rgba(239, 68, 68, 0.9); }
            `,
            onMount(container) {
                const tooltip = rootDocument.createElement('div');
                tooltip.className = `fluent-input-tooltip ${type}`;
                tooltip.id = 'fluent-input-translation-tooltip';
                tooltip.textContent = `${getTooltipIcon(type)} ${translateLegacyText(
                    message,
                    normalizeUiLanguage(deps.config.uiLanguage),
                )}`;
                tooltip.style.top = `${rect.bottom + 12}px`;
                tooltip.style.left = `${rect.left + (rect.width / 2)}px`;
                tooltip.style.transform = 'translateX(-50%) translateY(3px)';
                tooltip.style.opacity = deps.config.animations ? '0' : '1';
                container.appendChild(tooltip);
                return tooltip;
            },
        });

        if (
            signal.aborted
            || requestId !== activeInputTranslationRequestId
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
        if (!deps.config.animations) {
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'translateX(-50%) translateY(0)';
        } else {
            tooltip.style.opacity = '0';
            setTimeout(() => tooltip.classList.add('show'), 10);
        }

        return tooltip;
    };

    const handleInputBoxTranslation = async (
        element: HTMLElement,
        signal: AbortSignal,
    ): Promise<void> => {
        invalidate();
        const requestId = activeInputTranslationRequestId;
        activeInputTranslationElement = element;
        const configGeneration = deps.readConfigGeneration();
        const inputSnapshot = getInputBoxValueSnapshot(element);
        const originalText = getInputBoxText(element);
        const trigger = deps.config.inputBoxTranslationTrigger;
        const targetLanguage = deps.config.inputBoxTranslationTarget;

        const isCurrentAndUnchanged = () => requestId === activeInputTranslationRequestId
            && isInputElement(element)
            && canCommitInputBoxTranslation({
                signal,
                expectedValue: inputSnapshot,
                currentValue: getInputBoxValueSnapshot(element),
                expectedConfigGeneration: configGeneration,
                currentConfigGeneration: deps.readConfigGeneration(),
                isEnabled: isEnabled(),
                isSiteDisabled: deps.isSiteDisabled(),
            });
        const clearOwnedVisuals = () => {
            if (requestId !== activeInputTranslationRequestId) return;
            element.classList.remove('fluent-input-translating');
            if (activeInputTranslationElement === element) activeInputTranslationElement = null;
            removeExistingTooltip(requestId);
        };
        const handleAbort = () => clearOwnedVisuals();
        signal.addEventListener('abort', handleAbort, { once: true });

        try {
            // 步骤 1：固定输入快照和配置 generation；任何用户编辑、关闭或站点禁用都会阻止写回。
            if (!isCurrentAndUnchanged() || !originalText) return;
            const cleanedText = removeTriggerSymbols(originalText, trigger);
            if (!cleanedText) return;

            // 步骤 2：只让当前请求拥有输入框动画和 tooltip，旧请求不能清理新提示。
            removeExistingTooltip();
            addInputBoxAnimation(element, 'translating', requestId);
            const loadingTooltip = await createTranslationTooltip(
                element,
                '微软翻译中',
                'translating',
                requestId,
                signal,
            );
            if (!loadingTooltip || !isCurrentAndUnchanged()) {
                clearOwnedVisuals();
                return;
            }

            try {
                // 步骤 3：background 消息不能中断，结果落地前再次校验快照和 feature signal。
                const translatedText = await translateWithMicrosoft(deps.sendMessage, cleanedText, targetLanguage);
                if (!isCurrentAndUnchanged()) {
                    clearOwnedVisuals();
                    return;
                }

                element.classList.remove('fluent-input-translating');
                removeExistingTooltip(requestId);
                if (translatedText && translatedText !== cleanedText) {
                    setInputBoxText(element, translatedText);
                    addInputBoxAnimation(element, 'success', requestId);
                    await createTranslationTooltip(element, '翻译成功', 'success', requestId, signal);
                } else {
                    addInputBoxAnimation(element, 'error', requestId);
                    await createTranslationTooltip(element, '内容无需翻译', 'error', requestId, signal);
                }
            } catch (translationError) {
                if (!isCurrentAndUnchanged()) {
                    clearOwnedVisuals();
                    return;
                }
                element.classList.remove('fluent-input-translating');
                addInputBoxAnimation(element, 'error', requestId);
                removeExistingTooltip(requestId);
                await createTranslationTooltip(element, '微软翻译失败', 'error', requestId, signal);
                logger.error('微软翻译失败:', translationError);
            }

            setTimeout(() => removeExistingTooltip(requestId), 2500);
        } catch (error) {
            if (!isCurrentAndUnchanged()) {
                clearOwnedVisuals();
                return;
            }
            logger.error('输入框翻译失败:', error);
            element.classList.remove('fluent-input-translating');
            addInputBoxAnimation(element, 'error', requestId);
            removeExistingTooltip(requestId);
            await createTranslationTooltip(element, '翻译服务暂时不可用', 'error', requestId, signal);
            setTimeout(() => removeExistingTooltip(requestId), 3000);
        } finally {
            signal.removeEventListener('abort', handleAbort);
        }
    };

    const mount = (signal: AbortSignal): void => {
        let keyPressCount = 0;
        let keyPressTimer: ReturnType<typeof setTimeout> | null = null;
        let lastInputElement: HTMLElement | null = null;
        const tripleKeyTimeout = 1000;

        const resetKeyPresses = () => {
            keyPressCount = 0;
            lastInputElement = null;
            if (keyPressTimer) {
                clearTimeout(keyPressTimer);
                keyPressTimer = null;
            }
        };

        const handleKeyDown = async (event: KeyboardEvent) => {
            if (!event.isTrusted) return;
            if (deps.isSiteDisabled()) return;
            if (!isEnabled()) {
                resetKeyPresses();
                return;
            }
            // IME 的选词/确认和长按属于宿主编辑会话；不能吞键或把此前的三连计数
            // 带到组合输入结束后。229 兼容部分浏览器的首尾组合事件。
            if (event.isComposing || event.keyCode === 229 || event.repeat
                || event.altKey || event.metaKey || event.shiftKey) {
                resetKeyPresses();
                return;
            }

            const activeElement = getDeepActiveElement(rootDocument);
            if (!isInputElement(activeElement)) {
                resetKeyPresses();
                return;
            }

            const triggerType = deps.config.inputBoxTranslationTrigger;
            // 步骤 1：Ctrl+Enter 立即触发；三连击只记录同一个输入目标上的连续目标按键。
            if (triggerType === 'ctrl_enter') {
                if (event.ctrlKey && event.key === 'Enter') {
                    event.preventDefault();
                    await handleInputBoxTranslation(activeElement, signal);
                }
                return;
            }

            if (triggerType === 'triple_space' || triggerType === 'triple_equal' || triggerType === 'triple_dash') {
                if (event.ctrlKey || !matchesInputBoxTrigger(event, triggerType as InputBoxTrigger)) {
                    resetKeyPresses();
                    return;
                }

                if (lastInputElement !== activeElement) {
                    keyPressCount = 1;
                    lastInputElement = activeElement;
                } else {
                    keyPressCount += 1;
                }

                // 步骤 2：第三次按键先阻止触发符号继续进入页面，再启动异步翻译。
                if (keyPressCount === 3) {
                    event.preventDefault();
                    resetKeyPresses();
                    await handleInputBoxTranslation(activeElement, signal);
                    return;
                }

                if (keyPressTimer) clearTimeout(keyPressTimer);
                keyPressTimer = setTimeout(resetKeyPresses, tripleKeyTimeout);
            }
        };

        rootDocument.addEventListener('keydown', handleKeyDown, { capture: true, signal });
        signal.addEventListener('abort', () => {
            resetKeyPresses();
            invalidate();
        }, { once: true });
    };

    return { mount, invalidate };
}

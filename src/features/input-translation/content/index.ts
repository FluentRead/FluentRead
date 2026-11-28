/**
 * @file src/features/input-translation/content/index.ts
 * 文件职责：实现网页输入框翻译 feature 的可注入生命周期，协调三连触发符（含中文输入法下的过程键与全角符号提交）与快捷键识别、冻结请求所有权、调用后台并把译文安全提交回原控件或富文本编辑器。
 * 主要内容：转发 configKey 的契约与写回工具，通过 tooltipUi 管理 closed Shadow 状态提示，维护输入编辑代次、三连击与中文 IME 过程键/全角提交状态机以及写回/取消/恢复原文事务，防止失焦、编辑或配置变化后的迟到提交。
 * 模块边界：本文件拥有内容页事件与请求编排，不直接调用 provider 或全局 browser API；配置键与底层写回由 configKey.ts 负责，Shadow 提示渲染由 tooltipUi.ts 负责，输入纯算法来自 inputBox.ts，编辑宿主度量与写回来自 editableHost.ts。
 */

import {normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {services as translationServices, servicesType} from '@/src/core/config/catalog';
import {
    matchesCustomInputBoxTranslationHotkey,
    normalizeInputBoxTranslationOutputMode,
    type InputBoxTranslationOutputMode,
} from '@/src/core/config/inputTranslation';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {TRANSLATION_CANCEL_MESSAGE_TYPE} from '@/src/services/translation/types';
import {
    INPUT_MACHINE_PROVIDER_TIMEOUT_MS,
    INPUT_TRANSLATION_RESPONSE_GRACE_MS,
    INPUT_TRANSLATION_TIMEOUT_MS,
    inputBoxTranslationConfigKey,
    isInputBoxTranslationEnabled,
    setInputBoxText,
    translateInputBox,
    type InputTranslationContentConfig,
    type InputTranslationContentDependencies,
    type InputTranslationContentFeature,
} from './configKey';
import {
    insertIntoEditableCaretState,
    isSameEditableCaretState,
    readEditableCaretState,
    replaceEditableText,
    type EditableCaretState,
} from './editableHost';
import {
    canCommitInputBoxTranslation,
    getDeepActiveElement,
    getInputBoxSelection,
    getInputBoxText,
    getInputBoxValueAfterInsertion,
    getInputBoxValueSnapshot,
    isFormControl,
    isImeProcessedKeyEvent,
    isInputElement,
    matchesInputBoxTrigger,
    matchInsertedControlTriggerSymbol,
    matchInsertedEditableTriggerSymbol,
    normalizeInputBoxTranslationInterval,
    removeInsertedTriggerSymbols,
    resolveInputBoxTriggerSymbol,
    type InputBoxSelection,
    type InputBoxTrigger,
} from './inputBox';
import {createInputTranslationTooltipController} from './tooltipUi';

export {
    INPUT_TRANSLATION_TIMEOUT_MS,
    inputBoxTranslationConfigKey,
    isInputBoxTranslationEnabled,
    setInputBoxText,
    type InputTranslationContentConfig,
    type InputTranslationContentDependencies,
    type InputTranslationContentFeature,
};

let featureSequence = 0;

export function createInputTranslationContentFeature(
    deps: InputTranslationContentDependencies,
): InputTranslationContentFeature {
    const rootDocument = deps.document;
    const logger = deps.logger;
    let activeInputTranslationRequestId = 0;
    let activeInputTranslationElement: HTMLElement | null = null;
    let activeRequestController: AbortController | null = null;
    let activeRequestSnapshot: string | null = null;
    // 取消 ID 由 sender scope 隔离；时间、实例序号与 nonce 保持唯一，普通 HTTP 页面也能创建 feature。
    const requestPrefix = `input:${Date.now().toString(36)}:${++featureSequence}:${Math.random().toString(36).slice(2)}`;
    let internalWriteElement: HTMLElement | null = null;
    let internalWriteToken: symbol | null = null;
    const editGenerations = new WeakMap<HTMLElement, number>();
    const observedInputValues = new WeakMap<HTMLElement, string>();
    const bilingualOutputs = new WeakMap<HTMLElement, string>();
    const visualTimers = new Set<ReturnType<typeof setTimeout>>();
    const later = (callback: () => void, delay: number): void => {
        const timer = setTimeout(() => { visualTimers.delete(timer); callback(); }, delay);
        visualTimers.add(timer);
    };

    const isEnabled = () => isInputBoxTranslationEnabled(deps.config, deps.isSiteDisabled());
    const tooltip = createInputTranslationTooltipController({
        deps,
        later,
        isEnabled,
        getActiveRequestId: () => activeInputTranslationRequestId,
        onTooltipDetached: () => {
            if (activeRequestController === null) activeInputTranslationElement = null;
        },
    });

    const invalidate = (): void => {
        // abort 的同步监听会释放活动宿主，先冻结引用以完整移除成功/错误样式。
        const element = activeInputTranslationElement;
        activeRequestController?.abort();
        visualTimers.forEach(clearTimeout);
        visualTimers.clear();
        tooltip.clearFading();
        activeRequestController = null;
        activeRequestSnapshot = null;
        activeInputTranslationRequestId += 1;
        element?.classList.remove('fluent-input-translating');
        element?.classList.remove('fluent-input-success', 'fluent-input-error');
        activeInputTranslationElement = null;
        tooltip.remove(undefined, true);
    };

    const readEditGeneration = (element: HTMLElement): number => editGenerations.get(element) || 0;
    const recordEdit = (element: HTMLElement): void => {
        editGenerations.set(element, readEditGeneration(element) + 1);
    };

    /** 写回期间把宿主事件标记为扩展自身编辑，避免把自己的 input 当作用户编辑而取消请求。 */
    const writeOwnedText = async (
        element: HTMLElement,
        text: string,
        isCurrent: () => boolean,
        outputMode: InputBoxTranslationOutputMode = 'replace',
    ): Promise<boolean> => {
        const token = Symbol('input-write');
        internalWriteToken = token;
        internalWriteElement = element;
        const ownsController = activeRequestController === null;
        const controller = activeRequestController || new AbortController();
        if (ownsController) {
            activeRequestController = controller;
            activeInputTranslationElement = element;
        }
        try {
            return await setInputBoxText(element, text, isCurrent, outputMode, controller.signal);
        } finally {
            if (ownsController && activeRequestController === controller) activeRequestController = null;
            if (internalWriteToken === token) {
                internalWriteElement = null;
                internalWriteToken = null;
            }
        }
    };

    const addInputBoxAnimation = (
        element: HTMLElement,
        animationType: 'translating' | 'success' | 'error',
    ): void => {
        if (!deps.config.animations) return;

        element.classList.remove('fluent-input-translating', 'fluent-input-success', 'fluent-input-error');
        element.classList.add(`fluent-input-${animationType}`);

        if (animationType !== 'translating') {
            later(() => {
                element.classList.remove(`fluent-input-${animationType}`);
            }, animationType === 'success' ? 1000 : 600);
        }
    };

    const handleInputBoxTranslation = async (
        element: HTMLElement,
        signal: AbortSignal,
        sourceTextOverride?: string,
    ): Promise<void> => {
        const originalText = sourceTextOverride ?? getInputBoxText(element);
        const outputMode = normalizeInputBoxTranslationOutputMode(deps.config.inputBoxTranslationOutputMode);
        const bilingual = outputMode !== 'replace';
        if (bilingual && bilingualOutputs.get(element) === originalText) return;
        if (activeRequestController && activeInputTranslationElement === element
            && activeRequestSnapshot === getInputBoxValueSnapshot(element)) return;
        invalidate();
        const requestId = activeInputTranslationRequestId;
        const requestController = new AbortController();
        activeRequestController = requestController;
        const requestSignal = requestController.signal;
        activeInputTranslationElement = element;
        const configGeneration = deps.readConfigGeneration();
        const inputSnapshot = getInputBoxValueSnapshot(element);
        activeRequestSnapshot = inputSnapshot;
        const clientRequestId = `${requestPrefix}:${requestId}`;
        const editGeneration = readEditGeneration(element);
        observedInputValues.set(element, inputSnapshot);
        const targetLanguage = deps.config.inputBoxTranslationTarget;
        const service = deps.config.inputBoxTranslationService || deps.config.service || translationServices.freeTranslation;
        const isAI = servicesType.isAI(service);
        const requestTimeoutMs = isAI ? normalizeAiRequestTimeoutMs(deps.config.aiRequestTimeoutMs) : INPUT_MACHINE_PROVIDER_TIMEOUT_MS;
        const responseTimeoutMs = isAI ? requestTimeoutMs + INPUT_TRANSLATION_RESPONSE_GRACE_MS : INPUT_TRANSLATION_TIMEOUT_MS;

        const isCurrentAndUnchanged = () => requestId === activeInputTranslationRequestId
            && isInputElement(element)
            && element.isConnected !== false
            && (isFormControl(element) || getDeepActiveElement(rootDocument) === element)
            && canCommitInputBoxTranslation({
                signal: {aborted: signal.aborted || requestSignal.aborted} as AbortSignal,
                expectedValue: inputSnapshot,
                currentValue: getInputBoxValueSnapshot(element),
                expectedConfigGeneration: configGeneration,
                currentConfigGeneration: deps.readConfigGeneration(),
                isEnabled: isEnabled(),
                isSiteDisabled: deps.isSiteDisabled(),
                expectedEditGeneration: editGeneration,
                currentEditGeneration: readEditGeneration(element),
            });
        const clearOwnedVisuals = () => {
            if (requestId !== activeInputTranslationRequestId) return;
            element.classList.remove('fluent-input-translating');
            if (activeInputTranslationElement === element) activeInputTranslationElement = null;
            tooltip.remove(requestId);
        };
        const handleAbort = () => clearOwnedVisuals();
        const cancelRemote = () => {
            try {
                void Promise.resolve(deps.sendMessage({type: TRANSLATION_CANCEL_MESSAGE_TYPE, clientRequestId})).catch(() => undefined);
            } catch { /* 卸载期间取消通知只能尽力发送，页面仍立即释放请求。 */ }
        };
        requestSignal.addEventListener('abort', cancelRemote, {once: true});
        signal.addEventListener('abort', handleAbort, {once: true});
        requestSignal.addEventListener('abort', handleAbort, {once: true});

        try {
            // 步骤 1：固定输入快照和配置 generation；任何用户编辑、关闭或站点禁用都会阻止写回。
            if (!isCurrentAndUnchanged() || !originalText) return;
            if (!originalText.trim()) return;
            if (bilingual && element.tagName.toLowerCase() === 'input') {
                await tooltip.show(element, '双语追加需要支持换行的输入框', 'error', requestId, requestSignal);
                tooltip.dismissLater(requestId);
                return;
            }

            // 步骤 2：只让当前请求拥有输入框动画和 tooltip，旧请求不能清理新提示。
            tooltip.remove();
            addInputBoxAnimation(element, 'translating');
            void tooltip.show(element, '翻译中', 'translating', requestId, requestSignal, {
                label: '取消',
                onRestore: async () => { if (requestId === activeInputTranslationRequestId) invalidate(); },
            });

            // 步骤 3：请求与提示并行启动；取消向共享 broker 传递，落地前再次校验快照。
            const translatedText = await translateInputBox(
                deps.sendMessage, originalText, targetLanguage, clientRequestId,
                requestSignal, cancelRemote, requestTimeoutMs, responseTimeoutMs,
            );
            if (!isCurrentAndUnchanged()) {
                clearOwnedVisuals();
                return;
            }

            if (hasDistinctTranslation(originalText, translatedText)) {
                // 步骤 4：编辑宿主写回需要等待编辑器同步选区，期间继续由当前请求持有提示和动画。
                // 原生控件一次写入原文和译文；富文本只在首尾插入，保留原文 DOM 与格式。
                const output = isFormControl(element) && bilingual
                    ? outputMode === 'prepend' ? `${translatedText}\n${originalText}` : `${originalText}\n${translatedText}`
                    : translatedText;
                const written = await writeOwnedText(element, output, isCurrentAndUnchanged, isFormControl(element) ? 'replace' : outputMode);
                // 自身写入会改变快照；只检验请求/配置所有权，避免宿主同步事件作废请求后继续显示旧成功。
                if (requestId !== activeInputTranslationRequestId
                    || deps.readConfigGeneration() !== configGeneration || !isEnabled() || deps.isSiteDisabled()
                    || !isInputElement(element) || element.isConnected === false
                    || (!written && !isCurrentAndUnchanged())) {
                    clearOwnedVisuals();
                    return;
                }
                element.classList.remove('fluent-input-translating');
                tooltip.remove(requestId);
                if (!written) {
                    addInputBoxAnimation(element, 'error');
                    // 宿主拒绝自动写入时保留可选择复制的译文，避免强行写 DOM 或丢弃结果。
                    await tooltip.show(element, '无法把译文写入当前编辑器', 'error', requestId, requestSignal, {
                        label: '关闭',
                        onRestore: async () => tooltip.remove(requestId),
                    }, translatedText);
                    return;
                }
                const translatedSnapshot = getInputBoxValueSnapshot(element);
                if (bilingual) bilingualOutputs.set(element, getInputBoxText(element));
                observedInputValues.set(element, translatedSnapshot);
                const translatedEditGeneration = readEditGeneration(element);
                const canRestore = () => !signal.aborted
                    && !requestSignal.aborted
                    && requestId === activeInputTranslationRequestId
                    && isInputElement(element)
                    && element.isConnected !== false
                    && deps.readConfigGeneration() === configGeneration
                    && readEditGeneration(element) === translatedEditGeneration
                    && getInputBoxValueSnapshot(element) === translatedSnapshot
                    && isEnabled()
                    && !deps.isSiteDisabled();
                addInputBoxAnimation(element, 'success');
                await tooltip.show(element, '翻译成功', 'success', requestId, requestSignal, {
                    label: '恢复原文',
                    onRestore: async () => {
                        // 选区同步或宿主提交等待中重复点击，只保留一次恢复写入。
                        if (activeRequestController) return;
                        if (!canRestore()) return;
                        if (!await writeOwnedText(element, originalText, canRestore)) return;
                        bilingualOutputs.delete(element);
                        observedInputValues.set(element, getInputBoxValueSnapshot(element));
                        tooltip.remove(requestId);
                    },
                });
            } else {
                element.classList.remove('fluent-input-translating');
                tooltip.remove(requestId);
                addInputBoxAnimation(element, 'error');
                await tooltip.show(element, '内容无需翻译', 'error', requestId, requestSignal);
            }
            tooltip.dismissLater(requestId);
        } catch (translationError) {
            if (!isCurrentAndUnchanged()) {
                clearOwnedVisuals();
                return;
            }
            element.classList.remove('fluent-input-translating');
            addInputBoxAnimation(element, 'error');
            tooltip.remove(requestId);
            await tooltip.show(element, '翻译失败，请重试', 'error', requestId, requestSignal, {
                label: '重试',
                onRestore: async () => {
                    if (isCurrentAndUnchanged()) await handleInputBoxTranslation(element, signal, originalText);
                },
            });
            logger.error('输入框翻译失败:', translationError);
            tooltip.dismissLater(requestId);
        } finally {
            signal.removeEventListener('abort', handleAbort);
            requestSignal.removeEventListener('abort', handleAbort);
            requestSignal.removeEventListener('abort', cancelRemote);
            if (activeRequestController === requestController) {
                activeRequestController = null;
                activeRequestSnapshot = null;
            }
        }
    };

    const mount = (signal: AbortSignal): void => {
        let keyPressCount = 0;
        let keyPressTimer: ReturnType<typeof setTimeout> | null = null;
        // 原生控件按 value/选区区间校验连续插入；编辑宿主的块级 DOM 无法映射为 value 区间，
        // 改用 textContent 口径的文本与折叠光标偏移校验，并在第一次插入前冻结可见原文。
        type TriggerSequence = {
            element: HTMLElement;
            trigger: InputBoxTrigger;
            insertedSymbols: string;
        } & ({
            kind: 'control';
            insertedStart: number;
            expectedValue: string;
            expectedSelection: InputBoxSelection;
        } | {
            kind: 'editable';
            sourceText: string;
            expectedCaret: EditableCaretState;
        });
        // 中文输入法空闲时按 = / - 常触发 Process(229)，keydown 阶段既无法阻止默认插入也未知最终全/半角符号；
        // 改为记录按键前快照，待 input 或 compositionend 确认恰好插入单个触发符后再推进序列。
        type PendingImeTrigger = {
            element: HTMLElement;
            trigger: InputBoxTrigger;
            sawComposition: boolean;
        } & ({
            kind: 'control';
            beforeValue: string;
            beforeSelection: InputBoxSelection;
        } | {
            kind: 'editable';
            sourceText: string;
            beforeCaret: EditableCaretState;
        });
        let triggerSequence: TriggerSequence | null = null;
        let pendingImeTrigger: PendingImeTrigger | null = null;
        let composingElement: HTMLElement | null = null;

        const resetKeyPresses = () => {
            keyPressCount = 0;
            triggerSequence = null;
            pendingImeTrigger = null;
            if (keyPressTimer) {
                clearTimeout(keyPressTimer);
                keyPressTimer = null;
            }
        };

        const clearInputSequence = () => {
            composingElement = null;
            resetKeyPresses();
        };

        const scheduleKeyPressReset = () => {
            if (keyPressTimer) clearTimeout(keyPressTimer);
            keyPressTimer = setTimeout(
                resetKeyPresses,
                normalizeInputBoxTranslationInterval(deps.config.inputBoxTranslationInterval),
            );
        };

        const activeEventElement = (event: Event): HTMLElement | null => {
            const composedPath = event.composedPath?.();
            const pathInput = composedPath?.find((item): item is HTMLElement =>
                typeof (item as Element)?.tagName === 'string' && isInputElement(item as Element));
            if (pathInput) return pathInput;
            const target = event.target;
            if (target && typeof (target as Element).tagName === 'string' && isInputElement(target as Element)) {
                return target as HTMLElement;
            }
            const active = getDeepActiveElement(rootDocument);
            return isInputElement(active) ? active : null;
        };

        const selectionMatches = (element: HTMLElement, expected: InputBoxSelection): boolean => {
            const current = getInputBoxSelection(element);
            return current !== null
                && current.start === expected.start
                && current.end === expected.end;
        };

        const sequenceStillMatches = (sequence: TriggerSequence): boolean => (sequence.kind === 'control'
            ? getInputBoxValueSnapshot(sequence.element) === sequence.expectedValue
                && selectionMatches(sequence.element, sequence.expectedSelection)
            : isSameEditableCaretState(readEditableCaretState(sequence.element), sequence.expectedCaret));

        const pendingImeStillValid = (pending: PendingImeTrigger): boolean => {
            if (pending.sawComposition) return true;
            if (pending.kind === 'control') {
                const currentValue = getInputBoxValueSnapshot(pending.element);
                return (currentValue === pending.beforeValue && selectionMatches(pending.element, pending.beforeSelection))
                    || matchInsertedControlTriggerSymbol(
                        pending.beforeValue,
                        pending.beforeSelection,
                        currentValue,
                        getInputBoxSelection(pending.element),
                        pending.trigger,
                    ) !== null;
            }
            const currentCaret = readEditableCaretState(pending.element);
            return isSameEditableCaretState(currentCaret, pending.beforeCaret)
                || matchInsertedEditableTriggerSymbol(pending.beforeCaret, currentCaret, pending.trigger) !== null;
        };

        const triggerTripleTranslation = async (
            element: HTMLElement,
            sourceText: string,
            insertedSymbols: string,
        ): Promise<void> => {
            resetKeyPresses();
            invalidate();
            const generation = deps.readConfigGeneration();
            const cleanupRequestId = activeInputTranslationRequestId;
            if (isFormControl(element)) {
                await writeOwnedText(element, sourceText, () => true);
                if (cleanupRequestId !== activeInputTranslationRequestId
                    || generation !== deps.readConfigGeneration() || !isEnabled()) return;
                await handleInputBoxTranslation(element, signal, sourceText);
                return;
            }
            const snapshot = getInputBoxValueSnapshot(element);
            const editGeneration = readEditGeneration(element);
            const cleanupController = new AbortController();
            activeRequestController = cleanupController;
            activeInputTranslationElement = element;
            const token = Symbol('trigger-cleanup');
            internalWriteToken = token;
            internalWriteElement = element;
            const cleanupSymbol = insertedSymbols.length === 2 && insertedSymbols[0] === insertedSymbols[1]
                ? insertedSymbols[0]
                : insertedSymbols;
            try {
                const cleaned = await replaceEditableText(element, '', () => !signal.aborted && !cleanupController.signal.aborted
                    && cleanupRequestId === activeInputTranslationRequestId
                    && getDeepActiveElement(rootDocument) === element
                    && isEnabled() && !deps.isSiteDisabled() && isInputElement(element) && element.isConnected !== false
                    && readEditGeneration(element) === editGeneration
                    && deps.readConfigGeneration() === generation
                    && getInputBoxValueSnapshot(element) === snapshot, 'trigger', cleanupSymbol, cleanupController.signal);
                if (cleaned !== 'replaced') return;
            } finally {
                if (internalWriteToken === token) {
                    internalWriteElement = null;
                    internalWriteToken = null;
                }
                if (activeRequestController === cleanupController) {
                    activeRequestController = null;
                    activeInputTranslationElement = null;
                }
            }
            if (cleanupRequestId !== activeInputTranslationRequestId
                || generation !== deps.readConfigGeneration() || !isEnabled()) return;
            await handleInputBoxTranslation(element, signal, sourceText);
        };

        const consumePendingImeTrigger = async (
            pending: PendingImeTrigger,
            fromCompositionEnd = false,
        ): Promise<void> => {
            const element = pending.element;
            if (deps.isSiteDisabled() || !isEnabled()) {
                resetKeyPresses();
                return;
            }
            const matchedSymbol = pending.kind === 'control'
                ? matchInsertedControlTriggerSymbol(
                    pending.beforeValue,
                    pending.beforeSelection,
                    getInputBoxValueSnapshot(element),
                    getInputBoxSelection(element),
                    pending.trigger,
                )
                : matchInsertedEditableTriggerSymbol(
                    pending.beforeCaret,
                    readEditableCaretState(element),
                    pending.trigger,
                );
            if (!matchedSymbol) {
                // Firefox 等浏览器可能在 compositionend 后才派发 insertFromComposition input；
                // 若内容尚未落地则保留 pending 等待紧随的 input，否则说明 IME 未插入触发符。
                if (fromCompositionEnd && (pending.kind === 'control'
                    ? getInputBoxValueSnapshot(element) === pending.beforeValue
                        && selectionMatches(element, pending.beforeSelection)
                    : isSameEditableCaretState(readEditableCaretState(element), pending.beforeCaret))) {
                    pending.sawComposition = false;
                    return;
                }
                resetKeyPresses();
                return;
            }

            pendingImeTrigger = null;
            const currentSnapshot = getInputBoxValueSnapshot(element);
            observedInputValues.set(element, currentSnapshot);

            let sourceText: string;
            let insertedSymbols: string;
            if (pending.kind === 'control') {
                const currentSelection = getInputBoxSelection(element)!;
                if (triggerSequence?.kind === 'control') {
                    keyPressCount += 1;
                    triggerSequence.insertedSymbols += matchedSymbol;
                    triggerSequence.expectedValue = currentSnapshot;
                    triggerSequence.expectedSelection = currentSelection;
                    insertedSymbols = triggerSequence.insertedSymbols;
                    sourceText = removeInsertedTriggerSymbols(
                        currentSnapshot,
                        pending.trigger,
                        triggerSequence.insertedStart,
                        insertedSymbols.length,
                    );
                } else {
                    keyPressCount = 1;
                    insertedSymbols = matchedSymbol;
                    triggerSequence = {
                        kind: 'control',
                        element,
                        trigger: pending.trigger,
                        insertedStart: pending.beforeSelection.start,
                        insertedSymbols,
                        expectedValue: currentSnapshot,
                        expectedSelection: currentSelection,
                    };
                    sourceText = pending.beforeValue;
                }
            } else {
                const currentCaret = readEditableCaretState(element)!;
                if (triggerSequence?.kind === 'editable') {
                    keyPressCount += 1;
                    triggerSequence.insertedSymbols += matchedSymbol;
                    triggerSequence.expectedCaret = currentCaret;
                    insertedSymbols = triggerSequence.insertedSymbols;
                    sourceText = triggerSequence.sourceText;
                } else {
                    keyPressCount = 1;
                    insertedSymbols = matchedSymbol;
                    triggerSequence = {
                        kind: 'editable',
                        element,
                        trigger: pending.trigger,
                        insertedSymbols,
                        sourceText: pending.sourceText,
                        expectedCaret: currentCaret,
                    };
                    sourceText = pending.sourceText;
                }
            }

            if (keyPressCount === 3) {
                await triggerTripleTranslation(element, sourceText, insertedSymbols);
                return;
            }
            scheduleKeyPressReset();
        };

        const handleMutation = (event: Event): Promise<void> | void => {
            if (!activeInputTranslationElement && !triggerSequence && !pendingImeTrigger) return;
            const element = activeEventElement(event);
            if (!element || !isInputElement(element)) return;
            if (element !== activeInputTranslationElement
                && element !== triggerSequence?.element
                && element !== pendingImeTrigger?.element) return;
            const currentValue = getInputBoxValueSnapshot(element);
            const valueChanged = observedInputValues.get(element) !== currentValue;
            if (valueChanged) {
                recordEdit(element);
                observedInputValues.set(element, currentValue);
            }
            if (valueChanged
                && internalWriteElement !== element
                && activeInputTranslationElement === element) {
                if (activeRequestController) invalidate();
                else tooltip.remove();
            }
            if (pendingImeTrigger?.element === element) {
                if (pendingImeTrigger.sawComposition) return;
                return consumePendingImeTrigger(pendingImeTrigger);
            }
            if (!triggerSequence || triggerSequence.element !== element) return;
            if (!sequenceStillMatches(triggerSequence)) resetKeyPresses();
        };

        const handleSelectionChange = () => {
            if (pendingImeTrigger) {
                if (!pendingImeStillValid(pendingImeTrigger)) resetKeyPresses();
                return;
            }
            if (triggerSequence && !sequenceStillMatches(triggerSequence)) resetKeyPresses();
        };

        const handleCompositionStart = (event: Event) => {
            const activeRequestElement = activeInputTranslationElement;
            const element = activeEventElement(event);
            if (pendingImeTrigger && element && pendingImeTrigger.element === element) {
                pendingImeTrigger.sawComposition = true;
            } else {
                composingElement = element;
                resetKeyPresses();
            }
            handleMutation(event);
            if (activeRequestElement && activeRequestController) invalidate();
        };

        const handleCompositionEnd = (event: Event): Promise<void> | void => {
            composingElement = null;
            const element = activeEventElement(event);
            if (pendingImeTrigger && element && pendingImeTrigger.element === element) {
                return consumePendingImeTrigger(pendingImeTrigger, true);
            }
            resetKeyPresses();
        };

        const handleClipboardEdit = (event: Event) => {
            if (event.isTrusted && activeRequestController && internalWriteElement
                && activeEventElement(event) === internalWriteElement) invalidate();
        };

        const armPendingImeTrigger = (element: HTMLElement, trigger: InputBoxTrigger): void => {
            if (triggerSequence && (triggerSequence.element !== element
                || triggerSequence.trigger !== trigger
                || !sequenceStillMatches(triggerSequence))) {
                resetKeyPresses();
            }
            if (isFormControl(element)) {
                const beforeSelection = getInputBoxSelection(element);
                if (!beforeSelection) {
                    resetKeyPresses();
                    return;
                }
                pendingImeTrigger = {
                    kind: 'control',
                    element,
                    trigger,
                    sawComposition: false,
                    beforeValue: getInputBoxValueSnapshot(element),
                    beforeSelection,
                };
            } else {
                const beforeCaret = readEditableCaretState(element);
                if (!beforeCaret) {
                    resetKeyPresses();
                    return;
                }
                const sourceText = triggerSequence?.kind === 'editable'
                    ? triggerSequence.sourceText
                    : getInputBoxText(element);
                pendingImeTrigger = {
                    kind: 'editable',
                    element,
                    trigger,
                    sawComposition: false,
                    sourceText,
                    beforeCaret,
                };
            }
            scheduleKeyPressReset();
        };

        /** 推进原生控件的三连序列，返回清理本次插入符号后的原文与已插入符号串；选区不可用时返回 null。 */
        const advanceControlSequence = (
            element: HTMLInputElement | HTMLTextAreaElement,
            trigger: InputBoxTrigger,
            symbol: string,
        ): {sourceText: string; insertedSymbols: string} | null => {
            const currentValue = getInputBoxValueSnapshot(element);
            const currentSelection = getInputBoxSelection(element);
            if (!currentSelection) return null;
            const afterInsertion = getInputBoxValueAfterInsertion(currentValue, currentSelection, symbol);
            if (triggerSequence?.kind === 'control'
                && triggerSequence.element === element
                && triggerSequence.trigger === trigger
                && sequenceStillMatches(triggerSequence)) {
                const insertedSymbols = triggerSequence.insertedSymbols;
                keyPressCount += 1;
                triggerSequence.insertedSymbols += symbol;
                triggerSequence.expectedValue = afterInsertion.value;
                triggerSequence.expectedSelection = afterInsertion.selection;
                return {
                    sourceText: removeInsertedTriggerSymbols(
                        currentValue,
                        trigger,
                        triggerSequence.insertedStart,
                        insertedSymbols.length,
                    ),
                    insertedSymbols,
                };
            }
            keyPressCount = 1;
            triggerSequence = {
                kind: 'control',
                element,
                trigger,
                insertedStart: currentSelection.start,
                insertedSymbols: symbol,
                expectedValue: afterInsertion.value,
                expectedSelection: afterInsertion.selection,
            };
            return {sourceText: currentValue, insertedSymbols: ''};
        };

        /** 推进编辑宿主的三连序列，返回第一次插入前冻结的可见原文与已插入符号串；光标不可用时返回 null。 */
        const advanceEditableSequence = (
            element: HTMLElement,
            trigger: InputBoxTrigger,
            symbol: string,
        ): {sourceText: string; insertedSymbols: string} | null => {
            const caret = readEditableCaretState(element);
            if (!caret) return null;
            const expectedCaret = insertIntoEditableCaretState(caret, symbol);
            if (triggerSequence?.kind === 'editable'
                && triggerSequence.element === element
                && triggerSequence.trigger === trigger
                && isSameEditableCaretState(caret, triggerSequence.expectedCaret)) {
                const insertedSymbols = triggerSequence.insertedSymbols;
                keyPressCount += 1;
                triggerSequence.insertedSymbols += symbol;
                triggerSequence.expectedCaret = expectedCaret;
                return {sourceText: triggerSequence.sourceText, insertedSymbols};
            }
            keyPressCount = 1;
            // 块级换行只能从渲染后的可见文本读取，而插入后的触发符无法精确映射回 innerText，
            // 因此在第一次插入前冻结原文。
            const sourceText = getInputBoxText(element);
            triggerSequence = {kind: 'editable', element, trigger, insertedSymbols: symbol, sourceText, expectedCaret};
            return {sourceText, insertedSymbols: ''};
        };

        const handleKeyDown = async (event: KeyboardEvent) => {
            if (!event.isTrusted) return;
            if (deps.isSiteDisabled()) return;
            if (!isEnabled()) {
                resetKeyPresses();
                return;
            }
            const isDirectTrigger = deps.config.inputBoxTranslationTrigger === 'custom'
                ? matchesCustomInputBoxTranslationHotkey(event, deps.config.customInputBoxTranslationHotkey)
                : deps.config.inputBoxTranslationTrigger === 'ctrl_enter'
                    && Boolean(event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'Enter');
            // 编辑器同步模型选区时可能临时选中全文；先取消并同步还原旧光标，
            // 再把用户的新按键交给宿主，避免默认输入直接覆盖整篇草稿。
            if (internalWriteElement === activeInputTranslationElement && activeRequestController
                && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)
                && !isDirectTrigger
                && event.key !== 'Escape') invalidate();
            if (event.key === 'Escape' && !isDirectTrigger) {
                if (activeRequestController && getDeepActiveElement(rootDocument) === activeInputTranslationElement) {
                    event.preventDefault();
                    event.stopPropagation();
                    invalidate();
                }
                resetKeyPresses();
                return;
            }
            const activeElement = getDeepActiveElement(rootDocument);
            // IME 选词/翻页中的组合会话和长按属于宿主编辑会话；不能吞键或把此前的三连计数
            // 带到组合输入结束后。
            if (event.isComposing || (composingElement !== null && composingElement === activeElement) || event.repeat) {
                resetKeyPresses();
                return;
            }

            if (!isInputElement(activeElement)) {
                resetKeyPresses();
                return;
            }

            const triggerType = deps.config.inputBoxTranslationTrigger;
            const imeProcessed = isImeProcessedKeyEvent(event);
            if (triggerType === 'custom') {
                if (imeProcessed) {
                    resetKeyPresses();
                    return;
                }
                if (isDirectTrigger) {
                    event.preventDefault();
                    event.stopPropagation();
                    await handleInputBoxTranslation(activeElement, signal);
                }
                return;
            }
            if (event.altKey || event.metaKey || event.shiftKey) {
                resetKeyPresses();
                return;
            }
            // 步骤 1：保留 Ctrl+Enter 兼容触发；三连击把 Ctrl 视为中断修饰键。
            // 已消费的触发键不再传给页面，避免聊天和评论编辑器把 Ctrl+Enter 当作发送。
            if (triggerType === 'ctrl_enter') {
                if (imeProcessed) {
                    resetKeyPresses();
                    return;
                }
                if (isDirectTrigger) {
                    event.preventDefault();
                    event.stopPropagation();
                    await handleInputBoxTranslation(activeElement, signal);
                }
                return;
            }

            if (triggerType === 'triple_space' || triggerType === 'triple_equal' || triggerType === 'triple_dash') {
                const trigger = triggerType as InputBoxTrigger;
                const matchesTriggerKey = matchesInputBoxTrigger(event, trigger)
                    || (imeProcessed && !event.code);
                if (event.ctrlKey || !matchesTriggerKey) {
                    if (pendingImeTrigger?.sawComposition) composingElement = pendingImeTrigger.element;
                    resetKeyPresses();
                    return;
                }
                if (pendingImeTrigger) {
                    const hadComposition = pendingImeTrigger.sawComposition;
                    const previousElement = pendingImeTrigger.element;
                    resetKeyPresses();
                    if (hadComposition) {
                        composingElement = previousElement;
                        return;
                    }
                }
                if (imeProcessed) {
                    armPendingImeTrigger(activeElement, trigger);
                    return;
                }

                const symbol = resolveInputBoxTriggerSymbol(event, trigger);
                // 步骤 2：按控件类型推进连续序列；无法可靠读取选区或光标时保留宿主输入。
                const step = isFormControl(activeElement)
                    ? advanceControlSequence(activeElement, trigger, symbol)
                    : advanceEditableSequence(activeElement, trigger, symbol);
                if (step === null) {
                    resetKeyPresses();
                    return;
                }

                // 步骤 3：第三次按键先阻止触发符号继续进入页面，再启动异步翻译。
                if (keyPressCount === 3) {
                    event.preventDefault();
                    event.stopPropagation();
                    await triggerTripleTranslation(activeElement, step.sourceText, step.insertedSymbols);
                    return;
                }

                scheduleKeyPressReset();
            }
        };

        rootDocument.addEventListener('keydown', handleKeyDown, {capture: true, signal});
        rootDocument.addEventListener('input', handleMutation, {capture: true, signal});
        rootDocument.addEventListener('change', handleMutation, {capture: true, signal});
        rootDocument.addEventListener('compositionstart', handleCompositionStart, {capture: true, signal});
        rootDocument.addEventListener('paste', handleClipboardEdit, {capture: true, signal});
        rootDocument.addEventListener('cut', handleClipboardEdit, {capture: true, signal});
        rootDocument.addEventListener('compositionend', handleCompositionEnd, {capture: true, signal});
        rootDocument.addEventListener('focusin', clearInputSequence, {capture: true, signal});
        rootDocument.addEventListener('focusout', (event: FocusEvent) => {
            clearInputSequence();
            // 仅富文本需要聚焦并改选区；离开编辑器后取消，避免迟到结果夺回用户焦点。
            if (activeRequestController && activeInputTranslationElement
                && !isFormControl(activeInputTranslationElement)
                && activeEventElement(event) === activeInputTranslationElement) invalidate();
        }, {capture: true, signal});
        rootDocument.addEventListener('selectionchange', handleSelectionChange, {capture: true, signal});
        signal.addEventListener('abort', () => {
            clearInputSequence();
            invalidate();
        }, {once: true});
    };

    return {mount, invalidate};
}

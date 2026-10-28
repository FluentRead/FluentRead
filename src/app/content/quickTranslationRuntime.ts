/**
 * @file src/app/content/quickTranslationRuntime.ts
 * 文件职责：把快捷翻译手势 feature 与当前页面配置、划词优先级及全文、悬停和局部容器选择执行器组装起来。
 * 主要内容：解析方案的请求级覆盖，协调旧单例监听器与多方案路由，并用全文会话身份保持快捷方案切换与悬停取消语义；实际执行悬停或全文方案前结束尚未确认的指针选区。
 * 模块边界：本文件只做 content composition；手势判定属于 quick-translation feature，翻译请求与 DOM 状态属于 full-page feature。
 */
import type {PageTranslationInvocation} from '@/src/features/full-page-translation/public';
import type {Config} from '@/src/core/config/model';
import {startSectionTranslationPicker} from '@/src/features/section-translation/public';
import {cancelPointerSelectionSession} from '@/src/shared/dom/pointerSelectionSession';
import {isEditingInPage} from '@/src/shared/dom/editingTarget';
import {resolveQuickTranslationInvocation} from '@/src/features/quick-translation/core';
import {mountQuickTranslationContentFeature} from '@/src/features/quick-translation/public';
import {isTranslationServiceAvailable} from '@/src/services/translation/capabilities';
import type {ContentHotkeyRuntime} from './hotkeyRuntime';
import {
    autoTranslateEnglishPage,
    cancelPendingHoverTranslation,
    handleTranslation,
    isFullPageTranslationActive,
    getFullPageTranslationSessionId,
    restoreOriginalContent,
} from '@/src/features/full-page-translation/public';

/** 安装额外方案；命中时清空旧手势状态，再由当前方案独占后续按键。 */
export function mountConfiguredQuickTranslation(
    config: Config,
    hotkeys: ContentHotkeyRuntime,
    isSiteDisabled: () => boolean,
    signal: AbortSignal,
    resetLegacyKeyboardGestures: () => void = () => undefined,
    runFullPage?: (invocation: PageTranslationInvocation) => void,
): void {
    let activeFullPageInvocation = '';
    let activeFullPageSessionId: number | undefined;
    mountQuickTranslationContentFeature({
        config,
        document,
        window,
        isSiteDisabled,
        isEditing: isEditingInPage,
        isProfileAvailable: (profile) => isTranslationServiceAvailable(profile.service || config.service),
        ...hotkeys.selectionShortcutPorts,
        resetLegacyKeyboardGestures,
        cancelPendingHoverTranslation,
        runHover: (profile, mouseX, mouseY, invocation = {}) => {
            cancelPointerSelectionSession();
            return handleTranslation(mouseX, mouseY, {
                ...resolveQuickTranslationInvocation(profile, config),
                ...invocation,
            });
        },
        runSection: (profile) => {
            startSectionTranslationPicker(resolveQuickTranslationInvocation(profile, config));
        },
        runFullPage: (profile) => {
            cancelPointerSelectionSession();
            const invocation = resolveQuickTranslationInvocation(profile, config);
            if (runFullPage) { cancelPendingHoverTranslation(); runFullPage(invocation); return; }
            const invocationIdentity = JSON.stringify(invocation);
            cancelPendingHoverTranslation();
            if (isFullPageTranslationActive()) {
                const shouldStop = activeFullPageInvocation === invocationIdentity
                    && activeFullPageSessionId !== undefined
                    && activeFullPageSessionId === getFullPageTranslationSessionId();
                restoreOriginalContent();
                if (shouldStop) return;
            } else {
                restoreOriginalContent();
            }
            const sessionId = autoTranslateEnglishPage(invocation);
            if (sessionId !== undefined && getFullPageTranslationSessionId() === sessionId) {
                activeFullPageInvocation = invocationIdentity;
                activeFullPageSessionId = sessionId;
            }
        },
    }, signal);
}

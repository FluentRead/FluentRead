/**
 * @file src/features/paragraph-copy/content/index.ts
 * 文件职责：在宿主页面监听段落复制快捷键，把鼠标当前所指的段落文字按配置口径写入剪贴板，并用页内通知说明复制结果。
 * 主要内容：记录最近一次指针位置，借助 shared/dom 过滤输入场景并检查站点停用状态，按候选或最近块级祖先定位段落，组合原文/译文/双语文本，先用 Clipboard API 再回退 execCommand，并在 AbortSignal 结束时移除监听。
 * 模块边界：本模块只处理手势、取词与剪贴板写入，不解析快捷键字符串、不发起翻译、不渲染设置界面；按键口径归 core/config/paragraphCopy，段落文本组合归 features/paragraph-copy/core，通知外观归 page-notice。
 */
import {config} from '@/src/services/config/store';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {
    matchesParagraphCopyHotkey,
    normalizeParagraphCopyContentMode,
} from '@/src/core/config/paragraphCopy';
import {resolveTranslationCandidateAtPoint} from '@/src/core/translation/public';
import {showPageNotice} from '@/src/features/page-notice/public';
import {deepActiveElement, isEditingInPage} from '@/src/shared/dom/editingTarget';
import {composeParagraphCopyText, findCopyableBlock, readParagraphTexts} from '../core';

export interface ParagraphCopyContentOptions {
    isSiteDisabled: () => boolean;
}

/** http 页面没有 Clipboard API，快捷键仍是可信手势，因此保留 execCommand 回退。 */
function copyWithExecCommand(text: string): boolean {
    let textarea: HTMLTextAreaElement | null = null;
    let focused: Element | null = null;
    let selection: Selection | null = null;
    const ranges: Range[] = [];
    let anchorNode: Node | null = null;
    let focusNode: Node | null = null;
    let anchorOffset = 0;
    let focusOffset = 0;
    let copied = false;
    try {
        const body = document.body;
        if (!body || typeof document.execCommand !== 'function') return false;
        focused = deepActiveElement(document);
        selection = document.getSelection();
        if (selection) {
            for (let index = 0; index < selection.rangeCount; index++) ranges.push(selection.getRangeAt(index).cloneRange());
            anchorNode = selection.anchorNode;
            focusNode = selection.focusNode;
            anchorOffset = selection.anchorOffset;
            focusOffset = selection.focusOffset;
        }
        textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('data-fluent-read-ui', 'paragraph-copy');
        textarea.setAttribute('aria-hidden', 'true');
        textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
        body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
    } catch {
        // 复制未完成时保持 false，临时节点与页面状态由 finally 清理。
    } finally {
        if (textarea) {
            // 页面 copy 处理器可能主动换焦点；只恢复我们临时占用的焦点和选区。
            const ownsFocus = deepActiveElement(document) === textarea;
            textarea.remove();
            if (ownsFocus) {
                try {
                    if (focused?.isConnected && typeof (focused as HTMLElement).focus === 'function') {
                        (focused as HTMLElement).focus({preventScroll: true});
                    }
                } catch {
                    // 宿主节点已变化或不允许聚焦，不影响复制结果和临时节点清理。
                }
                try {
                    if (selection) {
                        selection.removeAllRanges();
                        for (const range of ranges) selection.addRange(range);
                        if (ranges.length === 1 && anchorNode && focusNode && typeof selection.setBaseAndExtent === 'function') {
                            selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
                        }
                    }
                } catch {
                    // 页面在 copy 事件中移除了原选区，不让恢复失败泄漏未处理的 rejection。
                }
            }
        }
    }
    return copied;
}

async function writeClipboardText(text: string, isCurrent: () => boolean): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 权限被拒或页面失焦时继续尝试同步回退。
    }
    return isCurrent() && copyWithExecCommand(text);
}

/**
 * 挂载段落复制手势。指针位置由 pointermove 记录，快捷键按下时才解析段落，
 * 因此不会在浏览过程中持续做 DOM 查询。
 */
export function mountParagraphCopyContentFeature(
    options: ParagraphCopyContentOptions,
    signal: AbortSignal,
): void {
    let pointerX = Number.NaN;
    let pointerY = Number.NaN;
    let copyRevision = 0;
    const isEnabled = (): boolean => !signal.aborted && config.on === true
        && config.paragraphCopyEnabled === true && !options.isSiteDisabled();
    const notice = (key: string, tone: 'success' | 'error', params?: Record<string, string | number>): void => {
        showPageNotice(translate(key, normalizeUiLanguage(config.uiLanguage), params), tone, {key: 'paragraph-copy', signal});
    };

    const clearPointer = (): void => {
        pointerX = Number.NaN;
        pointerY = Number.NaN;
    };

    document.addEventListener('pointermove', (event) => {
        if (!event.isTrusted) return;
        pointerX = event.clientX;
        pointerY = event.clientY;
    }, {capture: true, passive: true, signal});
    window.addEventListener('blur', clearPointer, {signal});
    document.addEventListener('mouseout', (event) => {
        if (event.isTrusted && event.relatedTarget === null) clearPointer();
    }, {signal});
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') clearPointer();
    }, {signal});
    document.addEventListener('fluentread-route-change', clearPointer, {signal});

    const resolveParagraph = (): Element | null => {
        const candidate = resolveTranslationCandidateAtPoint(pointerX, pointerY, config.translationScope);
        if (candidate) return candidate.element;
        return findCopyableBlock(document.elementFromPoint(pointerX, pointerY));
    };

    const copyParagraphAtPointer = async (): Promise<void> => {
        const revision = ++copyRevision;
        const isCurrent = (): boolean => revision === copyRevision && isEnabled();
        try {
            if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) {
                notice('paragraphCopy.notice.noPointer', 'error');
                return;
            }
            const paragraph = resolveParagraph();
            const payload = paragraph
                ? composeParagraphCopyText(
                    readParagraphTexts(paragraph),
                    normalizeParagraphCopyContentMode(config.paragraphCopyContent),
                    config.translationBeforeOriginal === true,
                )
                : null;
            if (!payload) {
                notice('paragraphCopy.notice.empty', 'error');
                return;
            }
            const copied = await writeClipboardText(payload.text, isCurrent);
            if (!isCurrent()) return;
            if (!copied) {
                notice('paragraphCopy.notice.failed', 'error');
                return;
            }
            const key = payload.missingTranslation
                ? 'paragraphCopy.notice.copiedWithoutTranslation'
                : `paragraphCopy.notice.copied${payload.kind.charAt(0).toUpperCase()}${payload.kind.slice(1)}`;
            notice(key, 'success', {count: payload.text.length});
        } catch {
            if (isCurrent()) notice('paragraphCopy.notice.failed', 'error');
        }
    };

    document.addEventListener('keydown', (event) => {
        if (!event.isTrusted || event.repeat || event.isComposing || event.keyCode === 229) return;
        if (!isEnabled()) return;
        if (!matchesParagraphCopyHotkey(event, config.paragraphCopyHotkey, config.customParagraphCopyHotkey)) return;
        if (isEditingInPage(event)) return;
        event.preventDefault();
        event.stopPropagation();
        void copyParagraphAtPointer();
    }, {capture: true, signal});
}

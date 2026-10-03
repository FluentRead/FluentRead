/**
 * @file src/app/content/bilingualSentenceHighlight.ts
 * 文件职责：将内容应用的高亮配置接入逐句高亮功能的安装和卸载生命周期。
 * 主要内容：按 Document 幂等管理高亮实例、页面开关、样式属性与自定义绘制样式节点，配置变化即时生效，关闭时完整清理。
 * 模块边界：这里只负责页面级配置接线；句子定位归 full-page-translation feature，配置持久化由 config service 管理。
 */
import {installBilingualSentenceHighlight} from '@/src/features/full-page-translation/content/sentenceHighlight';
import {buildSentenceHighlightAppearanceCss, normalizeSentenceHighlightStyle} from '@/src/core/config/sentenceHighlight';

export const BILINGUAL_SENTENCE_HIGHLIGHT_ATTRIBUTE = 'data-fr-bilingual-sentence-highlight';
export const BILINGUAL_SENTENCE_HIGHLIGHT_STYLE_ATTRIBUTE = 'data-fr-bilingual-sentence-highlight-style';
export const BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID = 'fluent-read-sentence-highlight-appearance';
const disposers = new WeakMap<Document, () => void>();

export function syncBilingualSentenceHighlight(document: Document, enabled: boolean, style?: unknown, appearance?: unknown): void {
    const root = document.documentElement;
    if (!root) return;
    const css = enabled ? buildSentenceHighlightAppearanceCss(style, appearance) : '';
    const existing = document.getElementById(BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID);
    if (css) {
        const element = existing ?? document.createElement('style');
        element.id = BILINGUAL_SENTENCE_HIGHLIGHT_APPEARANCE_ID;
        if (element.textContent !== css) element.textContent = css;
        if (!element.isConnected) (document.head ?? root).appendChild(element);
    } else {
        existing?.remove();
    }
    if (enabled) {
        const normalizedStyle = normalizeSentenceHighlightStyle(style);
        if (root.getAttribute(BILINGUAL_SENTENCE_HIGHLIGHT_STYLE_ATTRIBUTE) !== normalizedStyle) root.setAttribute(BILINGUAL_SENTENCE_HIGHLIGHT_STYLE_ATTRIBUTE, normalizedStyle);
        if (disposers.has(document)) return;
        root.setAttribute(BILINGUAL_SENTENCE_HIGHLIGHT_ATTRIBUTE, 'true');
        disposers.set(document, installBilingualSentenceHighlight(document));
    } else {
        disposers.get(document)?.();
        disposers.delete(document);
        root.removeAttribute(BILINGUAL_SENTENCE_HIGHLIGHT_ATTRIBUTE);
        root.removeAttribute(BILINGUAL_SENTENCE_HIGHLIGHT_STYLE_ATTRIBUTE);
    }
}

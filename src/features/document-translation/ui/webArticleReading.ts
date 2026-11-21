/**
 * @file src/features/document-translation/ui/webArticleReading.ts
 * 文件职责：在已有文档预览框中恢复和保存网页正文的阅读位置。
 * 主要内容：按可滚动距离保存位置，连续滚动合并写入，页面换文档或关闭时收尾；当前阅读优先于迟到的历史位置。
 * 模块边界：仅使用传入的文档预览与历史端口，不切换阅读任务、不发翻译请求。
 */
import {normalizeWebArticleUrl} from '../core/webArticle';
import type {DocumentHistory} from '../services/history';

export function trackWebArticleReading(
    preview: Document, id: string, history: Pick<DocumentHistory, 'loadArticleProgress' | 'saveArticleProgress'>,
    openLink: (url: string) => void,
): () => void {
    const scroller = preview.scrollingElement;
    if (!scroller) return () => {};
    const distance = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const position = () => Math.min(1, Math.max(0, scroller.scrollTop / (distance() || 1)));
    let last = position();
    let dirty = false, disposed = false, scrolled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
        clearTimeout(timer);
        timer = undefined;
        if (!dirty) return;
        dirty = false;
        void history.saveArticleProgress(id, last);
    }
    function onScroll() {
        const next = position();
        if (next === last) return;
        last = next;
        dirty = scrolled = true;
        if (timer === undefined) timer = setTimeout(flush, 250);
    }
    function onLink(event: Event) {
        const element = event.target as Element | null;
        const link = element?.closest?.('a[href]');
        if (!link) return;
        event.preventDefault();
        const url = normalizeWebArticleUrl(link.getAttribute('href'));
        if (url) openLink(url);
    }
    preview.addEventListener('scroll', onScroll, {passive: true});
    preview.addEventListener('click', onLink);
    void history.loadArticleProgress(id).then(saved => {
        if (disposed || scrolled || saved === undefined) return;
        scroller.scrollTop = saved * distance();
        last = position();
    });
    return () => {
        disposed = true;
        preview.removeEventListener('scroll', onScroll);
        preview.removeEventListener('click', onLink);
        flush();
    };
}

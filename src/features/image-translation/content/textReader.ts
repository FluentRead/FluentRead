/**
 * @file src/features/image-translation/content/textReader.ts
 * 文件职责：提供图片翻译的可访问文字阅读面板，让小图与长译文也能完整阅读、核对原文和复制。
 * 主要内容：相同译文保留原文且不重复展示；以安全 textContent 渲染对照段落，提供仅译文/原文对照、复制反馈、关闭和局部 Escape；复制反馈只由当前操作和当前展示周期更新；面板固定在视口内并继承扩展自己的深浅色变量。
 * 模块边界：仅操作所属 Shadow DOM，不发送识别或翻译请求、不访问配置；宿主定位与生命周期由图片 runtime 管理，调用者提供本次结果和本地化函数。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
export interface ImageReaderLine {text: string; sourceText?: string}
export const IMAGE_READER_CSS = `
.fr-image-reader {--fr-image-brand:#dc315f;--fr-image-brand-soft:#fff0f4;--fr-image-ink:#172033;--fr-image-muted:#737c8f;--fr-image-line:#e5e8ef;--fr-image-surface:#fff;position:fixed;right:16px;top:16px;width:min(400px,calc(100vw - 24px));max-height:calc(100dvh - 32px);display:flex;flex-direction:column;box-sizing:border-box;border:1px solid var(--fr-image-line);border-radius:12px;background:var(--fr-image-surface);box-shadow:0 12px 40px #17203326;pointer-events:auto;z-index:3;color:var(--fr-image-ink);font:13px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
.fr-image-reader[hidden] {display:none!important;}
.fr-image-reader[data-theme=dark] {--fr-image-ink:#ece5ef;--fr-image-muted:#c1b1c5;--fr-image-line:#49404c;--fr-image-surface:#2b2630;--fr-image-brand-soft:#413548;--fr-image-brand:#ffa7ca;}
.fr-image-reader header {display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;padding:10px 12px;border-bottom:1px solid var(--fr-image-line);}
.fr-image-reader strong {flex:1;font-size:14px;}
.fr-image-reader button {all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:4px 8px;border-radius:6px;font:inherit;font-size:12px;cursor:pointer;}
.fr-image-reader button:hover,.fr-image-reader button[aria-pressed=true] {color:var(--fr-image-brand);background:var(--fr-image-brand-soft);}
.fr-image-reader button:focus-visible {outline:2px solid var(--fr-image-brand);outline-offset:2px;}
.fr-image-reader-body {overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 14px;user-select:text;}
.fr-image-reader article {padding:12px 0;}
.fr-image-reader article + article {border-top:1px solid var(--fr-image-line);}
.fr-image-reader pre {margin:0;font:inherit;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;}
.fr-image-reader .fr-image-reader-source {color:var(--fr-image-muted);font-size:12px;margin-bottom:6px;}
.fr-image-reader footer {display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0;padding:8px 12px;border-top:1px solid var(--fr-image-line);color:var(--fr-image-muted);font-size:11px;}
@media(max-width:480px) {.fr-image-reader{right:12px;top:12px;max-height:calc(100dvh - 24px)}}
`;

export function createImageTextReader(localize: (source: string) => string, onClose: () => void) {
    const element = document.createElement('section');
    element.className = 'fr-image-reader';
    element.hidden = true;
    element.tabIndex = -1;
    element.setAttribute('role', 'dialog');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.setAttribute('aria-pressed', 'false');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    header.append(title, compare, close);
    const body = document.createElement('div');
    body.className = 'fr-image-reader-body';
    body.tabIndex = 0;
    const footer = document.createElement('footer');
    const feedback = document.createElement('span');
    feedback.setAttribute('role', 'status');
    const copy = document.createElement('button');
    copy.type = 'button';
    footer.append(feedback, copy);
    element.append(header, body, footer);
    let lines: ImageReaderLine[] = [];
    let comparing = false;
    let disposed = false;
    let revision = 0;
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshLanguage = () => {
        title.textContent = localize('图片文字');
        element.setAttribute('aria-label', title.textContent);
        compare.textContent = localize('原文对照');
        close.setAttribute('aria-label', localize('关闭文字面板'));
        close.title = localize('关闭');
        copy.textContent = localize(comparing ? '复制对照' : '复制译文');
        feedback.textContent = localize('本地 OCR · 请核对名称和数字');
    };
    const render = () => {
        body.replaceChildren();
        for (const line of lines) {
            const article = document.createElement('article');
            const changed = line.sourceText !== undefined && hasDistinctTranslation(line.sourceText, line.text);
            if (comparing && changed) {
                const source = document.createElement('pre');
                source.className = 'fr-image-reader-source';
                source.dir = 'auto';
                source.textContent = line.sourceText!;
                article.append(source);
            }
            const translated = document.createElement('pre');
            translated.dir = 'auto';
            translated.textContent = !changed && line.sourceText !== undefined ? line.sourceText : line.text;
            article.append(translated);
            body.append(article);
        }
        compare.hidden = !lines.some(line => line.sourceText !== undefined && hasDistinctTranslation(line.sourceText, line.text));
        compare.setAttribute('aria-pressed', String(comparing));
        refreshLanguage();
    };
    const closeReader = () => {
        element.hidden = true;
        revision += 1;
        clearTimeout(feedbackTimer);
        onClose();
    };
    const handleClick = async (event: MouseEvent) => {
        if (!event.isTrusted || disposed) return;
        event.stopPropagation();
        if (event.target === close) closeReader();
        if (event.target === compare) {
            revision += 1;
            clearTimeout(feedbackTimer);
            comparing = !comparing;
            render();
        }
        if (event.target !== copy) return;
        const owner = ++revision;
        clearTimeout(feedbackTimer);
        feedback.textContent = localize('本地 OCR · 请核对名称和数字');
        const text = lines.map(line => comparing && line.sourceText !== undefined && hasDistinctTranslation(line.sourceText, line.text) ? `${line.sourceText}\n${line.text}` : line.sourceText !== undefined && !hasDistinctTranslation(line.sourceText, line.text) ? line.sourceText : line.text).join('\n\n');
        let message = '已复制';
        try { await navigator.clipboard.writeText(text); }
        catch { message = '复制失败，请选中文字后手动复制'; }
        if (disposed || owner !== revision || element.hidden) return;
        feedback.textContent = localize(message);
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => {
            if (!disposed && owner === revision && !element.hidden) refreshLanguage();
        }, 2500);
    };
    const isolate = (event: Event) => event.stopPropagation();
    const handleKeydown = (event: KeyboardEvent) => {
        event.stopPropagation();
        if (event.isTrusted && event.key === 'Escape') {event.preventDefault(); closeReader();}
    };
    element.addEventListener('click', handleClick);
    element.addEventListener('keydown', handleKeydown);
    for (const type of ['pointerdown', 'keyup', 'wheel']) element.addEventListener(type, isolate);
    refreshLanguage();
    return {
        element, refreshLanguage,
        setLines(next: ImageReaderLine[]) {revision += 1; clearTimeout(feedbackTimer); lines = next.map(line => ({...line})); render();},
        open() {
            // 外层也可直接隐藏面板；新展示周期必须拒绝先前复制的迟到反馈。
            revision += 1;
            clearTimeout(feedbackTimer);
            refreshLanguage();
            element.hidden = false;
            element.focus({preventScroll: true});
        },
        close: closeReader,
        dispose() {
            disposed = true;
            revision += 1;
            clearTimeout(feedbackTimer);
            element.removeEventListener('click', handleClick);
            element.removeEventListener('keydown', handleKeydown);
            for (const type of ['pointerdown', 'keyup', 'wheel']) element.removeEventListener(type, isolate);
            lines = [];
            element.remove();
        },
    };
}

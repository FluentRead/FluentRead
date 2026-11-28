/**
 * @file src/features/image-translation/content/textReader.ts
 * 文件职责：提供图片翻译的可访问文字阅读面板，让小图与长译文也能完整阅读、核对原文、单条复制与整段复制。
 * 主要内容：采用卡片式轻量阅读结构与面向普通用户的无术语提示；相同译文保留原文且不重复展示；以安全 textContent 渲染对照段落和保留原文导致未绘制的提示，支持每条悬停一键复制、仅译文/原文对照切换、当前操作独占的复制反馈、关闭和局部 Escape；关闭时沿完整 Shadow DOM 焦点链确认所有权；面板固定在视口内并继承扩展自己的深浅色变量，样式由独立 inline CSS 编译压缩。
 * 模块边界：仅操作所属 Shadow DOM，不发送识别或翻译请求、不访问配置；宿主定位与生命周期由图片 runtime 管理，调用者提供本次结果和本地化函数。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
export interface ImageReaderLine {text: string; sourceText?: string; renderSkipped?: true; numericUncertain?: true}
export interface ImageReaderLanguages {source: string; target: string}
export {default as IMAGE_READER_CSS} from '../ui/image-text-reader.css?inline';

const PAINT_SKIPPED_MESSAGE = '为保留原文，此译文未绘制到图片';
const READER_HINT_MESSAGE = '识别内容仅供参考，请核对数字与专名';

function appendReaderNote(parent: HTMLElement, message: string): void {
    const note = parent.ownerDocument.createElement('p');
    note.className = 'fr-image-reader-note';
    note.setAttribute('data-message', message);
    parent.append(note);
}

export function createImageTextReader(localize: (source: string) => string, onClose: (ownedFocus: boolean) => void) {
    const element = document.createElement('section');
    element.className = 'fr-image-reader';
    element.hidden = true;
    element.tabIndex = -1;
    element.setAttribute('role', 'dialog');
    const header = document.createElement('header');
    const titleGroup = document.createElement('div');
    titleGroup.className = 'fr-image-reader-title';
    const mark = document.createElement('span');
    mark.className = 'fr-image-reader-mark';
    mark.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    const count = document.createElement('span');
    count.className = 'fr-image-reader-count';
    count.hidden = true;
    titleGroup.append(mark, title, count);
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'fr-image-reader-compare';
    compare.setAttribute('aria-pressed', 'false');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fr-image-reader-close';
    close.textContent = '×';
    header.append(titleGroup, compare, close);
    const body = document.createElement('div');
    body.className = 'fr-image-reader-body';
    body.tabIndex = 0;
    const footer = document.createElement('footer');
    const feedback = document.createElement('span');
    feedback.setAttribute('role', 'status');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'fr-image-reader-copy';
    footer.append(feedback, copy);
    element.append(header, body, footer);
    let lines: ImageReaderLine[] = [];
    let sourceLanguage = '';
    let targetLanguage = '';
    let comparing = false;
    let disposed = false;
    let revision = 0;
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    const formatLineForCopy = (line: ImageReaderLine) => {
        const distinct = line.sourceText !== undefined && hasDistinctTranslation(line.sourceText, line.text);
        const value = comparing && distinct ? `${line.sourceText}\n${line.text}` : line.sourceText !== undefined && !distinct ? line.sourceText : line.text;
        return line.numericUncertain ? `${value}\n${localize('数字识别可能有误，请对照原图')}` : value;
    };
    const clearCopiedButtons = () => {
        body.querySelectorAll<HTMLElement>('.fr-image-reader-item-copy[data-copied=true]').forEach(button => {
            delete button.dataset.copied;
        });
    };
    const refreshLanguage = () => {
        title.textContent = localize('图片文字');
        element.setAttribute('aria-label', title.textContent);
        count.textContent = String(lines.length);
        count.hidden = lines.length === 0;
        compare.textContent = localize('原文对照');
        close.setAttribute('aria-label', localize('关闭文字面板'));
        close.title = localize('关闭');
        copy.textContent = localize(comparing ? '复制对照' : '复制译文');
        delete feedback.dataset.state;
        feedback.textContent = localize(READER_HINT_MESSAGE);
        const copyLabel = localize('复制');
        body.querySelectorAll<HTMLButtonElement>('.fr-image-reader-item-copy').forEach(button => {
            button.title = copyLabel;
            button.setAttribute('aria-label', copyLabel);
        });
        body.querySelectorAll('.fr-image-reader-note').forEach(note => {note.textContent = localize(note.getAttribute('data-message')!);});
    };
    const render = () => {
        body.replaceChildren();
        const sharedPaintNotice = lines.length > 1 && lines.every(line => line.renderSkipped);
        if (sharedPaintNotice) appendReaderNote(body, PAINT_SKIPPED_MESSAGE);
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const article = document.createElement('article');
            const changed = line.sourceText !== undefined && hasDistinctTranslation(line.sourceText, line.text);
            if (!changed && line.sourceText !== undefined) article.classList.add('is-original');
            if (line.renderSkipped) article.classList.add('is-skipped');
            const itemCopy = document.createElement('button');
            itemCopy.type = 'button';
            itemCopy.className = 'fr-image-reader-item-copy';
            itemCopy.dataset.lineIndex = String(index);
            article.append(itemCopy);
            if (comparing && changed) {
                const source = document.createElement('pre');
                source.className = 'fr-image-reader-source';
                source.dir = 'auto';
                source.lang = sourceLanguage;
                source.textContent = line.sourceText!;
                article.append(source);
            }
            const translated = document.createElement('pre');
            translated.dir = 'auto';
            const unchangedSource = changed ? undefined : line.sourceText;
            translated.lang = unchangedSource === undefined ? targetLanguage : sourceLanguage;
            translated.textContent = unchangedSource ?? line.text;
            article.append(translated);
            if (line.numericUncertain) appendReaderNote(article, '数字识别可能有误，请对照原图');
            if (line.renderSkipped && !sharedPaintNotice) appendReaderNote(article, PAINT_SKIPPED_MESSAGE);
            body.append(article);
        }
        compare.hidden = !lines.some(line => line.sourceText !== undefined && hasDistinctTranslation(line.sourceText, line.text));
        compare.setAttribute('aria-pressed', String(comparing));
        refreshLanguage();
    };
    const closeReader = () => {
        const doc = element.ownerDocument;
        let root = element.getRootNode() as Document | ShadowRoot;
        const active = root.activeElement;
        let ownedFocus = !element.hidden && !!active && element.contains(active);
        // 封闭或嵌套 ShadowRoot 可能仍保留内部活动元素；只有整条链都属于面板才归还焦点。
        while (ownedFocus && root !== doc) {
            const host = (root as ShadowRoot).host;
            root = host.getRootNode() as Document | ShadowRoot;
            ownedFocus = root.activeElement === host;
        }
        element.hidden = true;
        revision += 1;
        clearTimeout(feedbackTimer);
        clearCopiedButtons();
        onClose(ownedFocus);
    };
    const performCopy = async (text: string, sourceButton?: HTMLElement) => {
        const owner = ++revision;
        clearTimeout(feedbackTimer);
        clearCopiedButtons();
        delete feedback.dataset.state;
        feedback.textContent = localize(READER_HINT_MESSAGE);
        let copied = true;
        try { await navigator.clipboard.writeText(text); }
        catch { copied = false; }
        if (disposed || owner !== revision || element.hidden) return;
        feedback.dataset.state = copied ? 'copied' : 'error';
        feedback.textContent = localize(copied ? '已复制' : '复制失败，请选中文字后手动复制');
        if (copied && sourceButton?.isConnected) sourceButton.dataset.copied = 'true';
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => {
            if (!disposed && owner === revision && !element.hidden) {
                clearCopiedButtons();
                refreshLanguage();
            }
        }, 2500);
    };
    const handleClick = async (event: MouseEvent) => {
        if (!event.isTrusted || disposed) return;
        event.stopPropagation();
        const target = event.target as HTMLElement | null;
        if (target === close) {closeReader(); return;}
        if (target === compare) {
            revision += 1;
            clearTimeout(feedbackTimer);
            comparing = !comparing;
            render();
            return;
        }
        if (target?.classList?.contains('fr-image-reader-item-copy') && body.contains(target)) {
            await performCopy(formatLineForCopy(lines[Number(target.dataset.lineIndex)]), target);
            return;
        }
        if (target !== copy) return;
        await performCopy(lines.map(formatLineForCopy).join('\n\n'));
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
        setLines(next: ImageReaderLine[], languages?: ImageReaderLanguages) {
            revision += 1;
            clearTimeout(feedbackTimer);
            lines = next.map(line => ({...line}));
            // 空 lang 表示语言未知，避免自动识别的原文沿用宿主网页语言。
            sourceLanguage = languages?.source ?? '';
            targetLanguage = languages?.target ?? '';
            render();
        },
        open(takeFocus = true) {
            // 外层也可直接隐藏面板；新展示周期不能接收之前复制操作的迟到反馈。
            revision += 1;
            clearTimeout(feedbackTimer);
            clearCopiedButtons();
            refreshLanguage();
            element.hidden = false;
            if (takeFocus) element.focus({preventScroll: true});
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

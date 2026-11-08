/**
 * @file src/app/content/pageTranslationFont.ts
 * 文件职责：在当前文档执行全局浏览器默认译文字体偏好，立即同步已有及后续译文的独立样式树。
 * 主要内容：按 renderer 的弱根登记安装专属样式，以 CSS initial 优先执行浏览器标准字族；关闭该偏好时可执行当前文档的阅读系统字体，覆盖内联 CJK 字体与全局译文外观；关闭、页面停用或离开时仅撤销自有样式。
 * 模块边界：不直接读写配置、storage、原文或译文 DOM，不重新请求翻译、不扫描页面；组合根根据配置与页面许可同步样式，停用清理不修改已保存的选择，代码与公式子树继续使用自身字体。
 */
import {
    subscribeTranslationFontStyleRoots,
    releaseDocumentBilingualRenderingContainment,
    type TranslationFontStyleRoot,
} from '@/src/features/full-page-translation/content/public';

export const PAGE_TRANSLATION_FONT_STYLE_ID = 'fluent-read-page-translation-font';
const translated = ':is(.fluent-read-bilingual-content,.fluent-read-single-content)[data-fr-translation-owned="true"][data-fr-translation-owned="true"]';
const protectedFont = ':is(code,pre,kbd,samp,var,math,mjx-container,[class*="MathJax"],.katex,.mwe-math-element,.ltx_Math)';
// 直接指定后代，避免网页对子元素或字体预设单独设置的字族继续盖过浏览器标准字体。
export const PAGE_TRANSLATION_FONT_CSS = `${translated},\n${translated} *:not(${protectedFont},${protectedFont} *) { font-family: initial !important; }\n`;

export const PAGE_READING_SYSTEM_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const PAGE_READING_SYSTEM_FONT_CSS = PAGE_TRANSLATION_FONT_CSS.replace('initial', PAGE_READING_SYSTEM_FONT);

export interface PageTranslationFontRuntime {
    read(): boolean;
    set(browserDefault: boolean): boolean;
    setReadingSystem(value: boolean): boolean;
    reset(): void;
    dispose(): void;
}

/** document 是唯一作用域；frame 组合根可在自己的授权桥中创建同一控制器。 */
export function createPageTranslationFontRuntime(options: {
    document: Document;
    onChange?(browserDefault: boolean): void;
}): PageTranslationFontRuntime {
    let browserDefault = false;
    let readingSystem = false;
    const effectiveCss = () => browserDefault ? PAGE_TRANSLATION_FONT_CSS : readingSystem ? PAGE_READING_SYSTEM_FONT_CSS : '';
    let disposed = false;
    let installedRoots = 0;
    const styles = new Set<WeakRef<HTMLStyleElement>>();
    let rootStyles = new WeakMap<TranslationFontStyleRoot, HTMLStyleElement>();
    const install = (root: TranslationFontStyleRoot): void => {
        if (!effectiveCss() || disposed || (root !== options.document && root.ownerDocument !== options.document)) return;
        let style = rootStyles.get(root);
        if (!style) {
            style = options.document.createElement('style');
            style.id = PAGE_TRANSLATION_FONT_STYLE_ID;
            style.setAttribute('data-fr-translation-owned', 'true');
            rootStyles.set(root, style);
            styles.add(new WeakRef(style));
            // 无限滚动可能持续卸载闭合译文槽；只周期检查弱引用，不扫描宿主页面。
            if (++installedRoots % 64 === 0) {
                for (const reference of styles) if (!reference.deref()) styles.delete(reference);
            }
        }
        style.textContent = effectiveCss();
        const parent = root === options.document ? options.document.head ?? options.document.documentElement : root;
        if (style.parentNode !== parent) parent.appendChild(style);
    };
    const remove = (): void => {
        for (const reference of styles) reference.deref()?.remove();
        styles.clear();
        rootStyles = new WeakMap();
    };
    // 只在启用时订阅，既能回放旧根，也不会为常规翻译额外创建样式。
    let unsubscribe: (() => void) | undefined;
    const refresh = (previousCss: string): void => {
        const css = effectiveCss();
        if (css === previousCss) return;
        releaseDocumentBilingualRenderingContainment(options.document);
        if (css) {
            for (const reference of styles) {
                const style = reference.deref();
                if (style) style.textContent = css;
            }
            install(options.document);
            unsubscribe ??= subscribeTranslationFontStyleRoots(install);
        } else {
            unsubscribe?.(); unsubscribe = undefined;
            remove();
        }
    };
    const set = (value: boolean): boolean => {
        if (disposed) return false;
        if (browserDefault === value) return true;
        const previousCss = effectiveCss();
        browserDefault = value;
        refresh(previousCss);
        options.onChange?.(value);
        return true;
    };
    const setReadingSystem = (value: boolean): boolean => {
        if (disposed) return false;
        const previousCss = effectiveCss();
        readingSystem = value;
        refresh(previousCss);
        return true;
    };
    return {
        read: () => browserDefault,
        set,
        setReadingSystem,
        reset: () => { setReadingSystem(false); set(false); },
        dispose: () => {
            if (disposed) return;
            setReadingSystem(false); set(false);
            disposed = true;
        },
    };
}

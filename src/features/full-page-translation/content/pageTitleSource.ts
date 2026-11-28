/**
 * @file src/features/full-page-translation/content/pageTitleSource.ts
 * 文件职责：为全文翻译正文请求提供"页面原始标题"，避免标题被本扩展翻译替换后，把译文当作正文上下文与缓存键输入。
 * 主要内容：titleTranslation 在会话期间登记"原始标题 / 已写入译文"读取器；getPageSourceTitle 在当前标题恰为自身写入的译文时返回原始标题，否则返回 document.title。
 * 模块边界：本文件只保存一个读取器引用，不观察 DOM、不发请求、不写 document.title；标题翻译生命周期归 titleTranslation，请求构造归 translationRequest。
 */

export interface PageTitleTranslationView {
    /** 页面自己的标题文本。 */
    readonly originalTitle: string;
    /** 最近一次由标题翻译写入的译文；未写入时为 null。 */
    readonly appliedTitle: string | null;
}

let activeView: (() => PageTitleTranslationView) | null = null;

/** 标题翻译会话启动时登记读取器；返回的函数只会注销自己登记的那一份。 */
export function registerPageTitleTranslationView(read: () => PageTitleTranslationView): () => void {
    activeView = read;
    return () => {
        if (activeView === read) activeView = null;
    };
}

/** 正文请求使用的页面标题：标题已被替换为译文时回退到页面原始标题。 */
export function getPageSourceTitle(): string {
    const current = document.title;
    const view = activeView?.();
    if (view && view.appliedTitle !== null && current === view.appliedTitle) return view.originalTitle;
    return current;
}

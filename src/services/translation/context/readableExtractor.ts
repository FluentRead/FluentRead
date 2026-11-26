/**
 * @file src/services/translation/context/readableExtractor.ts
 *
 * 文件职责：按需加载完整网页正文提取器（Defuddle 与结构化 Markdown 转换器），供顶层网页和扩展页翻译上下文使用。
 * 主要内容：复用单次动态导入 Promise 并在失败后重置缓存，允许后续调用重试加载；子 frame 构建组可通过构建期别名替换为轻量空实现。
 * 模块边界：只负责模块动态加载边界，不读取页面 DOM、不清洗敏感属性，也不直接构造翻译上下文。
 */

export interface ReadablePageExtractor {
    Defuddle: typeof import('defuddle')['default'];
    createReadablePageMarkdown: typeof import('./markdown')['createReadablePageMarkdown'];
}

let extractorPromise: Promise<ReadablePageExtractor> | null = null;

export function loadReadablePageExtractor(): Promise<ReadablePageExtractor | null> {
    if (extractorPromise) return extractorPromise;
    const pending = Promise.all([import('defuddle'), import('./markdown')])
        .then(([{default: Defuddle}, {createReadablePageMarkdown}]) => ({Defuddle, createReadablePageMarkdown}));
    const wrapped = pending.catch((error) => {
        // 已创建的模块加载 Promise 在结算前不可替换。
        extractorPromise = null;
        throw error;
    });
    extractorPromise = wrapped;
    return extractorPromise;
}

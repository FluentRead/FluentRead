/**
 * @file src/features/hypothesis/selection.ts
 * 文件职责：给划词翻译保留官方 Hypothesis 选区工具栏的可点击空间。
 * 主要内容：只读取官方开放 Shadow Root 中实际可见的工具栏，将其上下边界纳入自动翻译卡的避让锚区。
 * 模块边界：不改变网页选区、不拦截事件、不移动或隐藏第三方 UI；手动调整的翻译卡仍由原有几何逻辑管理。
 */
export function hypothesisSelectionAnchor<T extends {top: number; bottom: number}>(anchor: T, document: Document): T {
    const toolbar = document.querySelector('hypothesis-adder')?.shadowRoot?.firstElementChild;
    const rect = toolbar?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return anchor;
    return {...anchor, top: Math.min(anchor.top, rect.top), bottom: Math.max(anchor.bottom, rect.bottom)};
}

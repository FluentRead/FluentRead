/**
 * @file src/features/full-page-translation/content/visibilityAnchor.ts
 * 文件职责：为全文翻译候选选择可供 IntersectionObserver 观察的实际布局盒。
 * 主要内容：优先使用候选自身，缺少布局盒时按文档顺序寻找非扩展后代，并优先进入开放 ShadowRoot；异常或不可用布局不阻断查找。
 * 模块边界：只读取候选的 DOM 与布局，不创建观察器、不更改 DOM、不调度或翻译；调用方负责无锚点时的回退。
 */
import {asHTMLElement} from './mutationObservation';
import {TRANSLATION_ARTIFACT_SELECTOR} from './translationStability';

function hasIntersectionLayoutBox(element: HTMLElement): boolean {
    if (typeof element.getClientRects !== "function") return false;
    try {
        const rects = element.getClientRects();
        for (let index = 0; index < rects.length; index += 1) {
            const rect = rects[index];
            if (rect && rect.width > 0 && rect.height > 0) return true;
        }
    } catch {
        // 脱离文档或自定义元素在重建布局时可能抛出异常。
    }
    return false;
}

/**
 * IntersectionObserver 无法可靠唤醒不生成布局盒的目标，典型情况是
 * `display: contents`。候选自身有布局盒时优先使用自身，否则按文档顺序遍历
 * 非扩展后代；找不到锚点时由调用方直接排队，并继续受全文 drain 并发限制。
 */
export function resolveFullPageVisibilityAnchor(candidate: HTMLElement): HTMLElement | null {
    if (hasIntersectionLayoutBox(candidate)) return candidate;

    const pending: Element[] = [];
    const pushChildrenInReverse = (container: ParentNode) => {
        for (let index = container.children.length - 1; index >= 0; index -= 1) {
            const child = container.children.item(index);
            if (child) pending.push(child);
        }
    };
    pushChildrenInReverse(candidate);

    while (pending.length > 0) {
        const element = pending.pop();
        if (!element || element.matches(TRANSLATION_ARTIFACT_SELECTOR)) continue;
        const htmlElement = asHTMLElement(element);
        if (htmlElement && hasIntersectionLayoutBox(htmlElement)) return htmlElement;

        // open Shadow DOM 既作为独立观察根参与全文翻译，也可能是宿主唯一的渲染盒。
        // 先压入 light DOM 子节点，使 LIFO 顺序优先访问 shadow 子节点。
        pushChildrenInReverse(element);
        if (element.shadowRoot) pushChildrenInReverse(element.shadowRoot);
    }
    return null;
}

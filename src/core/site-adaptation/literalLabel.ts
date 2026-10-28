/**
 * @file src/core/site-adaptation/literalLabel.ts
 * 文件职责：判定 JSON 指定范围中的字面标签，保护命令语法但保留相邻说明段。
 * 主要内容：忽略扩展副本，要求首个非空节点为 b/i 命令式标识符，其余文字只允许出现在平衡括号中。
 * 模块边界：只读取与克隆传入 DOM，不匹配站点或命令关键词，不改变宿主内容或读取配置。
 */
import {safeClosest} from '../translation/dom';

// 命令、参数、路径、逗号列表，以及命令后只接 -/-- 选项的组合（可跨行）。
// 普通粗体句子的后续单词没有选项前缀，仍然进入翻译；不内置命令词表。
const literalTokenPattern = /^[\w.+/-]+(?:(?:\s*,\s*[\w.+/-]+)+|(?:\s+--?\w[\w-]*)+)?$/u;

function matchesLiteralLabel(label: Element): boolean {
    const clone = label.cloneNode(true) as Element;
    clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach((node) => node.remove());
    const first = [...clone.childNodes].find((node) =>
        (node.nodeType === 1 || node.nodeType === 3) && Boolean(node.textContent!.trim()));
    if (!first || first.nodeType !== 1) return false;
    if (!(first as Element).matches('b, i')) return false;
    if (!literalTokenPattern.test(first.textContent!.trim())) return false;
    // 链接中的说明也属于普通文字，不能随链接一起删除后误认成标签。
    clone.querySelectorAll('b, i').forEach((node) => {
        if (literalTokenPattern.test(node.textContent!.trim())) node.remove();
    });
    let depth = 0;
    for (const character of clone.textContent!) {
        if (character === '(') depth += 1;
        else if (character === ')') {
            if (depth === 0) return false;
            depth -= 1;
        } else if (depth === 0 && /[\p{L}\p{N}]/u.test(character)) return false;
    }
    return depth === 0;
}

/** 选择器仅限定检查范围；命中选择器本身不足以把完整说明段判定为标签。 */
export function isLiteralLabel(element: Element, selectors: readonly string[]): boolean {
    return selectors.some((selector) => {
        const label = safeClosest(element, selector);
        return Boolean(label && matchesLiteralLabel(label));
    });
}

/** 字面标记仍留在译文骨架中；匹配范围内的完整句子不会仅因粗体或斜体而被保护。 */
export function isLiteralToken(element: Element, selectors: readonly string[]): boolean {
    return selectors.some((selector) => {
        const token = safeClosest(element, selector);
        if (!token) return false;
        // 双语译文是附加副本；仅译文模式的 single-slot 则包含原文，必须保留。
        const ownedBilingual = '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';
        if (!token.querySelector(ownedBilingual)) return literalTokenPattern.test(token.textContent!.trim());
        // 只读遍历保留原文，不克隆自定义元素以免触发构造器或站点副作用。
        const pending = Array.from(token.childNodes).reverse();
        let text = '';
        while (pending.length) {
            const node = pending.pop()!;
            if (node.nodeType === 3 || node.nodeType === 4) text += (node as CharacterData).data;
            else if (node.nodeType === 1 && !(node as Element).matches(ownedBilingual)) {
                for (let index = node.childNodes.length - 1; index >= 0; index -= 1) pending.push(node.childNodes[index]!);
            }
        }
        return literalTokenPattern.test(text.trim());
    });
}

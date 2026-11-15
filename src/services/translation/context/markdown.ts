/**
 * @file src/services/translation/context/markdown.ts
 *
 * 文件职责：把经过隐私清洗和 Defuddle core 提取的脱离页面正文投影为保留语义的 Markdown。
 * 主要内容：复用 Turndown 的标题、列表、引用和转义；补充数据表格、复杂表格 HTML、MathML 公式、提示块与脚注，并仅保留链接文字和图片说明。
 * 模块边界：只接受已清洗正文与脱离页面的 Document；不读取 live DOM、用户配置、URL 或网络，不重做文章识别或渲染公式。浏览器适配器负责隐私清洗、捕获预算、缓存和最终长度限制。
 */

import TurndownService from 'turndown';
import {MathMLToLaTeX} from 'mathml-to-latex';

function latexFromMath(node: HTMLElement): string | null {
    const annotation = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (annotation) return annotation;
    if (node.children.length) {
        try {
            const converted = MathMLToLaTeX.convert(node.outerHTML.replace(/&nbsp;/gu, '&#xA0;')).trim();
            if (converted) return converted;
        } catch {
            // 无法表示的公式继续保留 MathML，不能退化成丢失分数、根式或上下标关系的拼接文本。
        }
    }
    return node.getAttribute('data-latex')?.trim() || null;
}

function mathMarkdown(node: HTMLElement, inline = false): string {
    const latex = latexFromMath(node);
    if (!latex) return node.outerHTML;
    const onlyMathInParagraph = node.parentElement?.nodeName === 'P' &&
        Array.from(node.parentElement.childNodes).every(child => child === node || !child.textContent?.trim());
    const block = !inline && !node.closest('table') &&
        (node.getAttribute('display') === 'block' || onlyMathInParagraph);
    return block ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`;
}

function rawTable(node: HTMLElement): string {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const math of Array.from(clone.querySelectorAll<HTMLElement>('math'))) {
        const latex = latexFromMath(math);
        if (latex) math.replaceWith(clone.ownerDocument.createTextNode(`$${latex}$`));
    }
    return `\n\n${clone.outerHTML}\n\n`;
}

function tableMarkdown(node: HTMLElement, render: (node: HTMLElement) => string): string {
    const rows = Array.from(node.querySelectorAll<HTMLElement>('tr')).filter(row => row.closest('table') === node);
    const cells = rows.map(row => Array.from(row.children).filter((cell): cell is HTMLElement =>
        cell.nodeName === 'TD' || cell.nodeName === 'TH'));
    if (!rows.length || !cells.some(row => row.length)) return rawTable(node);

    // 合并单元格和表题无法用 GFM 表格可靠表示，保留结构和标签之间的关系。
    if (node.querySelector('[rowspan],[colspan],caption')) return rawTable(node);
    const nested = Array.from(node.querySelectorAll('table')).some(table => table !== node);
    const hasHeaders = cells.some(row => row.some(cell => cell.nodeName === 'TH'));
    if (nested || (!hasHeaders && cells.every(row => row.length <= 1))) {
        // 有表头的外层表格保留真实数据嵌套；无表头的布局表格按单元格阅读顺序拆开。
        if (nested && hasHeaders) return rawTable(node);
        return '\n\n' + cells.flat().map(render).join('\n\n') + '\n\n';
    }

    const values = cells.map(row => row.map(cell => render(cell)
        .replace(/\n/gu, ' ').trim().replace(/\|/gu, '\\|')));
    const columns = Math.max(...values.map(row => row.length));
    const formatRow = (row: string[]) => `| ${[...row, ...Array(columns - row.length).fill('')].join(' | ')} |`;
    return '\n\n' + [formatRow(values[0]), formatRow(Array(columns).fill('---')),
        ...values.slice(1).map(formatRow)].join('\n') + '\n\n';
}

function calloutMarkdown(node: HTMLElement, service: TurndownService, render: (node: HTMLElement) => string): string {
    const clone = node.cloneNode(true) as HTMLElement;
    const type = (clone.getAttribute('data-callout') || 'note').replace(/[^a-z0-9_-]/giu, '') || 'note';
    const title = clone.querySelector('.callout-title-inner, .callout-title')?.textContent?.trim() || type;
    const fold = clone.getAttribute('data-callout-fold');
    clone.querySelector('.callout-title')?.remove();
    const body = clone.querySelector<HTMLElement>('.callout-content') || clone;
    const quoted = render(body).split('\n').map(line => `> ${line}`).join('\n');
    return `\n\n> [!${type}]${fold === '+' || fold === '-' ? fold : ''} ${service.escape(title)}\n${quoted}\n\n`;
}

function footnoteMarkdown(node: HTMLElement, render: (node: HTMLElement) => string): string {
    const list = node.nodeName === 'OL' ? node : node.querySelector<HTMLElement>('ol');
    if (!list) return `\n\n${node.outerHTML}\n\n`;
    const items = Array.from(list.children).filter((child): child is HTMLElement => child.nodeName === 'LI');
    if (!items.length || items.some(item => !/^fn:[\w-]+$/u.test(item.id))) return `\n\n${node.outerHTML}\n\n`;
    const definitions = items.map(item => {
        const id = item.id.slice(3);
        const clone = item.cloneNode(true) as HTMLElement;
        const lines = render(clone).split('\n');
        return `[^${id}]: ${lines[0]}` + lines.slice(1).map(line => `\n    ${line}`).join('');
    });
    return `\n\n${definitions.join('\n\n')}\n\n`;
}

/** 将已清洗的 core 输出转换为模型上下文；不会依赖浏览器的全局 document 或 window。 */
export function createReadablePageMarkdown(content: string, ownerDocument: Document): string {
    const root = ownerDocument.createElement('div');
    root.innerHTML = content;
    // Core 会生成脚注链接等属性；投影不把生成的资源地址重新带入上下文或复杂表格 HTML。
    for (const element of Array.from(root.querySelectorAll('*'))) {
        for (const name of element.getAttributeNames()) {
            if (/^(?:href|src|srcset|poster|action|formaction|style|title)$/iu.test(name)) element.removeAttribute(name);
        }
    }
    root.querySelectorAll('.footnote-backref').forEach(backlink => backlink.remove());

    const service = new TurndownService({headingStyle: 'atx', hr: '---', bulletListMarker: '-',
        codeBlockStyle: 'fenced', emDelimiter: '*', preformattedCode: true});
    let inlineTableMath = false;
    const render = (node: HTMLElement): string => {
        const previous = inlineTableMath;
        inlineTableMath ||= Boolean(node.closest('table'));
        try {
            // Turndown 克隆节点而不重新解析 HTML；保留拆出 cell 之前的表内公式语境。
            return service.turndown(node);
        } finally {
            inlineTableMath = previous;
        }
    };
    const definitionIds = new Set(Array.from(root.querySelectorAll('[id^="fn:"]')).map(node => node.id.slice(3)));
    const escape = service.escape.bind(service);
    service.escape = text => escape(text).replace(/<(?=\/?[a-z][a-z0-9-]*(?:\s|\/?>))/giu, '\\<');
    service.remove(['script', 'style']);
    service.keep(['dl', 'dt', 'dd', 'details', 'summary', 'u', 'ins', 'q', 'abbr', 'cite']);
    service.addRule('linkText', {filter: 'a', replacement: text => text});
    service.addRule('imageText', {filter: 'img', replacement: (_, node) => service.escape(node.getAttribute('alt') || '')});
    service.addRule('strike', {filter: ['s', 'del', 'strike'], replacement: text => `~~${text}~~`});
    service.addRule('highlight', {filter: 'mark', replacement: text => `==${text}==`});
    service.addRule('indices', {filter: ['sub', 'sup'], replacement: (text, node) =>
        `<${node.nodeName.toLowerCase()}>${text}</${node.nodeName.toLowerCase()}>`});
    service.addRule('math', {filter: 'math', replacement: (_, node) => mathMarkdown(node, inlineTableMath)});
    service.addRule('table', {filter: 'table', replacement: (_, node) => tableMarkdown(node, render)});
    service.addRule('callout', {filter: node => node.classList.contains('callout') && node.hasAttribute('data-callout'),
        replacement: (_, node) => calloutMarkdown(node, service, render)});
    service.addRule('footnoteReference', {filter: node => node.nodeName === 'SUP' && /^fnref:[\w-]+$/u.test(node.id),
        replacement: (_, node) => {
            const reference = node.id.slice(6);
            const original = reference.replace(/-\d+$/u, '');
            const id = definitionIds.has(reference) || !definitionIds.has(original) ? reference : original;
            return `[^${id}]`;
        }});
    service.addRule('footnoteDefinitions', {filter: node => node.id === 'footnotes',
        replacement: (_, node) => footnoteMarkdown(node, render)});
    return render(root);
}

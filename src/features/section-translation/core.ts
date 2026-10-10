/**
 * @file src/features/section-translation/core.ts
 * 文件职责：定义局部翻译选择模式里“鼠标指着哪一块区域”的判定规则，把命中的任意节点收敛为可高亮、可翻译的块级容器，并提供向外扩大范围、元素简称与标签文案的纯计算。
 * 主要内容：导出几何判定、范围扩大、界面排除、元素简称、自然语言范围与有界原文预览及动作标签；复用抗表单命名控件遮蔽的标签读取，跨开放 Shadow DOM 排除 FluentRead 界面并提取原文，用 512 步预算限制祖先布局读取，跳过行内、零尺寸与媒体节点，安全映射译文工件的原文父级。
 * 模块边界：本模块只读取传入元素与注入的几何/样式端口，不注册监听、不创建界面、不发起翻译，也不读取配置；手势与高亮由 content/picker 负责，区域翻译由全文翻译 feature 的公开接口完成。
 */
import {getComposedParent, getElementTagName} from '@/src/core/translation/public';

/** 选择模式需要的最小几何端口；运行时使用真实布局，测试可注入确定数值。 */
export interface SectionGeometry {
    display(element: Element): string;
    rect(element: Element): SectionRect;
}

export interface SectionRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/** FluentRead 自己的界面宿主（悬浮球、划词卡片、页内通知、选择模式浮层等）不是网页内容。 */
export const SECTION_PICKER_UI_SELECTOR = [
    '[id^="fluent-read-"]',
    '[data-fluent-read-ui]',
    '.fluent-read-video-ui',
].join(',');

/** 译文、加载指示器和重试按钮属于某个原文段落；命中它们等同于命中该段落。 */
const TRANSLATION_ARTIFACT_SELECTOR = [
    '.fluent-read-bilingual-content',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '[data-fr-translation-owned="true"]',
].join(',');

/** 替换元素和矢量图本身不承载可翻译文字，从它们的父级开始寻找区域。 */
const NON_TEXT_TAGS = new Set(['svg', 'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'embed', 'object']);

const DOCUMENT_SURFACE_TAGS = new Set(['html', 'body', 'head']);
const MAX_ANCESTOR_STEPS = 512;

const tagNameOf = getElementTagName;

function closestOf(element: Element, selector: string): Element | null {
    return typeof element.closest === 'function' ? element.closest(selector) : null;
}

export function isSectionPickerUi(element: Element): boolean {
    // closest 不穿过 ShadowRoot；每棵树检查一次，再沿宿主继续，避免漏选扩展界面内部节点。
    for (let current: Element | null = element, depth = 0; current && depth < MAX_ANCESTOR_STEPS; depth += 1) {
        if (closestOf(current, SECTION_PICKER_UI_SELECTOR)) return true;
        const root: Node | undefined = current.getRootNode?.();
        current = root?.nodeType === 11 ? (root as ShadowRoot).host : null;
    }
    return false;
}

/** 行内、contents 与隐藏元素不形成独立盒子，高亮它们会让范围跳动，因此一律向上取块级容器。 */
function isBlockDisplay(display: string): boolean {
    const normalized = display.trim().toLowerCase();
    if (!normalized) return true;
    return normalized !== 'none' && normalized !== 'contents' && !normalized.startsWith('inline');
}

function isPickable(element: Element, geometry: SectionGeometry): boolean {
    if (DOCUMENT_SURFACE_TAGS.has(tagNameOf(element))) return false;
    if (!isBlockDisplay(geometry.display(element))) return false;
    const rect = geometry.rect(element);
    return rect.width > 0 && rect.height > 0;
}

function sameBox(left: SectionRect, right: SectionRect): boolean {
    return Math.abs(left.left - right.left) <= 1
        && Math.abs(left.top - right.top) <= 1
        && Math.abs(left.width - right.width) <= 1
        && Math.abs(left.height - right.height) <= 1;
}

/**
 * 把鼠标命中的节点收敛为最近的可选块级区域。命中 FluentRead 自身界面或只剩 html/body 时返回 null，
 * 由调用方保持“未选中”状态，而不是把整页当成候选。
 */
export function resolveSectionElement(hit: Element | null, geometry: SectionGeometry): Element | null {
    // 命中本身或组合祖先是 FluentRead 界面时不选区。
    if (!hit || isSectionPickerUi(hit)) return null;
    // 译文工件总挂在原文段落内部，回到它的父级即回到原文。
    const artifact = closestOf(hit, TRANSLATION_ARTIFACT_SELECTOR);
    const start = artifact ? getComposedParent(artifact) : hit;
    if (!start) return null;
    let current: Element | null = closestOf(start, 'svg') ?? start;
    if (NON_TEXT_TAGS.has(tagNameOf(current))) current = getComposedParent(current);
    for (let depth = 0; current && depth < MAX_ANCESTOR_STEPS; depth += 1) {
        if (isPickable(current, geometry)) return current;
        current = getComposedParent(current);
    }
    return null;
}

/** 向外扩大一级：跳过与当前盒子完全重合的包装层，保证每按一次范围都肉眼可见地变大；到顶时返回 null。 */
export function expandSectionElement(current: Element, geometry: SectionGeometry): Element | null {
    if (isSectionPickerUi(current)) return null;
    const base = geometry.rect(current);
    for (let parent = getComposedParent(current), depth = 0; parent && depth < MAX_ANCESTOR_STEPS; parent = getComposedParent(parent), depth += 1) {
        if (!isPickable(parent, geometry)) {
            if (DOCUMENT_SURFACE_TAGS.has(tagNameOf(parent))) return null;
            continue;
        }
        if (!sameBox(geometry.rect(parent), base)) return parent;
    }
    return null;
}

const SIMPLE_CLASS_TOKEN = /^[A-Za-z_-][\w-]*$/u;
const PREVIEW_EXCLUSION_SELECTOR = `${TRANSLATION_ARTIFACT_SELECTOR},${SECTION_PICKER_UI_SELECTOR},script,style,input,textarea,select`;

/** 用阅读语义介绍范围，用户无需认识 HTML 标签与网页内部类名。 */
export function describeSectionScope(element: Element): string {
    const tag = tagNameOf(element);
    const scope = /^(p|h[1-6]|blockquote|li|figcaption|dt|dd)$/u.test(tag) ? 'paragraph'
        : /^(ul|ol|dl)$/u.test(tag) ? 'list'
            : /^(table|thead|tbody|tfoot|tr|td|th)$/u.test(tag) ? 'table'
                : tag === 'article' || tag === 'main' ? 'article' : 'region';
    return `sectionTranslation.scope.${scope}`;
}

/** Light DOM 与开放影子树共用 160 节点和 88 字预算，避开译文、扩展界面、脚本与控件。 */
export function sectionSourcePreview(element: Element): string {
    let text = '';
    let steps = 0;
    const walk = (node: Node): void => {
        steps += 1;
        if (node.nodeType === 3) {
            text += `${node.textContent!.slice(0, 512).replace(/\s+/gu, ' ').trim()} `;
            return;
        }
        if (node.nodeType === 1) {
            const child = node as Element;
            if (child.matches(PREVIEW_EXCLUSION_SELECTOR)) return;
        }
        for (let child = node.firstChild; child && steps < 160 && text.length < 88; child = child.nextSibling) walk(child);
        // 区域翻译会发现开放影子树内的正文；宿主与其祖先的原文预览也应覆盖同一范围。
        if (node.nodeType === 1 && steps < 160 && text.length < 88) {
            const root = (node as Element).shadowRoot;
            if (root) walk(root);
        }
    };
    walk(element);
    text = text.trim();
    return text.length > 88 ? `${text.slice(0, 87)}…` : text;
}

/** 生成类似开发者工具的元素简称（如 article.markdown-body），帮助熟悉网页结构的用户确认范围。 */
export function describeSectionElement(element: Element): string {
    const tag = tagNameOf(element);
    const id = typeof element.id === 'string' && SIMPLE_CLASS_TOKEN.test(element.id) ? `#${element.id}` : '';
    const className = Array.from(element.classList)
        .find((token) => SIMPLE_CLASS_TOKEN.test(token) && !token.startsWith('fluent-read'));
    const label = `${tag}${id || (className ? `.${className}` : '')}`;
    return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

/** 标签只需要区域摘要中的这几项，避免 core 依赖全文翻译 feature 的完整类型。 */
export interface SectionLabelSummary {
    readonly total: number;
    readonly active: number;
    readonly pending: number;
    readonly truncated: boolean;
    readonly action: 'translate' | 'restore' | 'settled' | 'empty';
}

export interface SectionLabel {
    readonly key: string;
    readonly params?: Readonly<Record<string, string | number>>;
    readonly tone: 'translate' | 'restore' | 'muted';
}

/**
 * 把区域摘要转换为标签文案键：告诉用户点击后会发生什么（翻译多少段、恢复原文还是无事可做），
 * 单数使用 one 变体，让各语言都能写出自然的量词。
 */
export function resolveSectionLabel(summary: SectionLabelSummary): SectionLabel {
    if (summary.action === 'empty') return {key: 'sectionTranslation.label.empty', tone: 'muted'};
    if (summary.action === 'settled') return {key: 'sectionTranslation.label.settled', tone: 'muted'};
    if (summary.action === 'restore') {
        const count = Math.max(summary.active, 1);
        return {key: count === 1 ? 'sectionTranslation.label.restoreOne' : 'sectionTranslation.label.restore', params: {count}, tone: 'restore'};
    }
    if (summary.truncated) {
        // 预览只盘点了一部分：已看到的段落数是下限，一段都还没看到时不显示数字。
        const count = Math.max(summary.pending, summary.total);
        return count > 0
            ? {key: 'sectionTranslation.label.translateMany', params: {count}, tone: 'translate'}
            : {key: 'sectionTranslation.label.translateLarge', tone: 'translate'};
    }
    if (summary.active > 0) {
        return {
            key: summary.pending === 1 ? 'sectionTranslation.label.translateRemainingOne' : 'sectionTranslation.label.translateRemaining',
            params: {count: summary.pending},
            tone: 'translate',
        };
    }
    return {
        key: summary.pending === 1 ? 'sectionTranslation.label.translateOne' : 'sectionTranslation.label.translate',
        params: {count: summary.pending},
        tone: 'translate',
    };
}

/**
 * @file src/features/reading-appearance/content.ts
 * 文件职责：为网页原文提供可逆的系统无衬线字体会话。
 * 主要内容：按文字节点的容器选择正文，保护图标、公式、代码和交互控件；先读取原始字体再局部覆盖，并为非正文后代保留继承字体。按批次合并动态 DOM 与样式更新子树，追踪节点迁移和保护字体变化，忽略无关导航与控件内部变化，关闭时撤销本会话的属性并释放观察器。
 * 模块边界：只操作传入文档的 font-family，不改写文字或 DOM 结构、不访问配置；译文由组合层既有的共享字体样式运行时管理，不进入受控译文根。复杂伪元素容器保守跳过，不穿透未知闭合根或 iframe。
 */
import {getComposedParent, isIconFontElement} from '@/src/core/translation/dom';

export const READING_APPEARANCE_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export interface ReadingAppearancePorts {
    writeFontFamily?(element: HTMLElement, value: string, priority: string, removeEmptyStyle: boolean): void;
}
const excluded = 'script,style,noscript,template,pre,code,kbd,samp,textarea,input,select,option,button,form,nav,header,footer,svg,math,mjx-container,.katex,.MathJax,.mwe-math-element,[role="button"],[role="textbox"],[role="menu"],[role="navigation"],[role="toolbar"],[contenteditable]:not([contenteditable="false"]),[hidden],[inert],[aria-hidden="true"],[data-fluent-read-ui],[id^="fluent-read-"]';
const prose = 'p,h1,h2,h3,h4,h5,h6,li,dd,dt,blockquote,figcaption,article,main,.fluent-read-bilingual-content,[data-fr-translation-segment="true"]';
const observedAttributes = ['style', 'class', 'id', 'role', 'hidden', 'inert', 'aria-hidden', 'contenteditable', 'data-fluent-read-ui', 'data-fr-translation-owned', 'data-fr-translation-segment'];
const privateGlyph = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
const specialFont = /(?:monospace|courier|consolas|menlo|monaco|cascadia|fira code|source code|jetbrains mono|icon|symbol|fontawesome|font awesome|math)/i;
interface Override {value: string; priority: string; applied: string; hadStyle: boolean}
interface Entry {element: HTMLElement; family: string; target: boolean; parent?: Entry; blocked: boolean; reading: boolean}

export function createReadingAppearanceController(document: Document, ports: ReadingAppearancePorts = {}) {
    const view = document.defaultView;
    let enabled = false, disposed = false, timer: number | undefined;
    let observer: MutationObserver | undefined;
    const overrides = new Map<HTMLElement, Override>();
    const writeFontFamily = (element: HTMLElement, value: string, priority: string, removeEmptyStyle: boolean) => {
        if (ports.writeFontFamily) {ports.writeFontFamily(element, value, priority, removeEmptyStyle); return;}
        if (value) element.style.setProperty('font-family', value, priority);
        else element.style.removeProperty('font-family');
        if (removeEmptyStyle && !element.getAttribute('style')) element.removeAttribute('style');
    };
    const dirty = new Set<Element>();
    const known = new WeakMap<Element, Entry>();
    // 弱引用记录本会话曾承载覆盖的分支；纯导航控件的节点替换无需触发恢复扫描。
    let coveredBranches = new WeakSet<Element>();
    const shadowRoots = new Set<ShadowRoot>();
    let fullScan = true;
    const withinAny = (element: Element | null, ancestors: ReadonlySet<Element>): boolean => {
        for (let current = element; current; current = getComposedParent(current)) if (ancestors.has(current)) return true;
        return false;
    };
    const restore = (selected: (element: HTMLElement) => boolean = () => true) => {
        for (const [element, saved] of overrides) {
            if (!selected(element)) continue;
            overrides.delete(element);
            // 页面在会话中改写字体时保留新值，不用旧快照覆盖宿主的更新。
            if (element.style.getPropertyValue('font-family') !== saved.applied || element.style.getPropertyPriority('font-family') !== 'important') continue;
            writeFontFamily(element, saved.value, saved.priority, !saved.hadStyle);
        }
    };
    const apply = (element: HTMLElement, value: string) => {
        if (!value) return;
        const saved = {value: element.style.getPropertyValue('font-family'), priority: element.style.getPropertyPriority('font-family'), applied: '', hadStyle: element.hasAttribute('style')};
        writeFontFamily(element, value, 'important', false);
        saved.applied = element.style.getPropertyValue('font-family');
        overrides.set(element, saved);
    };
    const refresh = () => {
        timer = undefined;
        observer?.disconnect();
        // 继承字体受祖先覆盖影响；只提升到相关的最高覆盖祖先，保留其他段落。
        for (const element of [...dirty]) {
            let scope = element;
            for (let ancestor = getComposedParent(element); ancestor; ancestor = getComposedParent(ancestor)) {
                // 新保护容器可能在本批次中创建，先识别未知祖先，不能沿用迁移前的资格。
                if (ancestor !== document.documentElement && (!known.has(ancestor) || overrides.has(ancestor as HTMLElement))) scope = ancestor;
            }
            if (scope !== element) {dirty.delete(element); dirty.add(scope);}
        }
        // 集合式祖先查找避免一批 N 个变更逐对比较子树，恢复也只走各节点的祖先链。
        const scopes = fullScan ? (document.body ? [document.body] : []) : [...dirty].filter(element => element.isConnected && !withinAny(getComposedParent(element), dirty));
        const scopeSet = new Set(scopes);
        restore(element => !element.isConnected || withinAny(element, scopeSet));
        dirty.clear(); fullScan = false;
        const entries: Entry[] = [];
        for (const root of shadowRoots) if (!root.host.isConnected) shadowRoots.delete(root);
        const stack: Array<{element: Element; parent?: Entry; blocked: boolean; reading: boolean}> = [];
        for (const element of scopes) {
            const ancestor = getComposedParent(element);
            const parent = ancestor ? known.get(ancestor) : undefined;
            stack.push({element, parent, blocked: parent?.blocked ?? false, reading: parent?.reading ?? false});
        }
        while (stack.length) {
            const {element, parent, blocked, reading} = stack.pop()!;
            // 译文字体只由现有 pageTranslationFont 样式树控制；不写入其内联字体，
            // 也不固定译文边界的继承字体，避免两个 important 控制器互相覆盖。
            if (element.matches('[data-fr-translation-owned="true"],.fluent-read-bilingual-content,.fluent-read-single-content')) continue;
            const style = view!.getComputedStyle(element);
            const family = style.fontFamily || '';
            const text = Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => (node as Text).data).join('').trim();
            const protectedHere = blocked || element.matches(excluded) || isIconFontElement(element) || specialFont.test(family.split(',')[0]) || privateGlyph.test(text) || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
            const inProse = reading || element.matches(prose);
            let target = !protectedHere && /\p{L}/u.test(text) && (inProse || text.length >= 40);
            // 无法单独给伪元素保存继承字体；存在装饰内容的宿主保守保留原字体。
            if (target) for (const pseudo of ['::before', '::after']) {
                const content = view!.getComputedStyle(element, pseudo).content;
                if (content && !['none', 'normal', '""', "''"].includes(content)) target = false;
            }
            const entry: Entry = {element: element as HTMLElement, family, target, parent, blocked: protectedHere, reading: inProse};
            known.set(element, entry);
            entries.push(entry);
            const shadow = element.shadowRoot;
            if (shadow) {
                shadowRoots.add(shadow);
                for (const child of Array.from(shadow.children).reverse()) stack.push({element: child, parent: entry, blocked: protectedHere, reading: inProse});
            }
            for (const child of Array.from(element.children).reverse()) stack.push({element: child, parent: entry, blocked: protectedHere, reading: inProse});
        }
        // 只覆盖直接承载正文的元素；每个受影响的非正文子元素固定原字体，
        // 避免祖先的继承变化把代码、按钮和连字图标变成普通文本。
        const markedBranches = new Set<Element>();
        for (const entry of entries) {
            if (entry.target) apply(entry.element, READING_APPEARANCE_FONT);
            else if (entry.parent?.target) apply(entry.element, entry.family);
            // 本批次去重，不能因旧分支曾被标记就停止：节点迁移后祖先链已经改变。
            if (overrides.has(entry.element)) for (let ancestor: Element | null = entry.element; ancestor && !markedBranches.has(ancestor); ancestor = getComposedParent(ancestor)) {
                markedBranches.add(ancestor); coveredBranches.add(ancestor);
            }
        }
        if (!observer) observer = new view!.MutationObserver(records => {
            if (!records.length) {fullScan = true; schedule(); return;}
            let changed = false;
            for (const record of records) {
                const element = record.target.nodeType === 1 ? record.target as Element : record.target.nodeType === 11 ? (record.target as ShadowRoot).host : record.target.parentElement;
                if (!element) continue;
                // 移除通知必须先于保护区过滤处理：节点可能仍连接文档，但已迁入 nav/form。
                // 同时涵盖整个容器的移动、断连清理和同批次移除后重新插入。
                if (record.type === 'childList') for (const node of Array.from(record.removedNodes)) {
                    if (node.nodeType === 1 && coveredBranches.has(node as Element)) {dirty.add(node as Element); changed = true;}
                }
                if (element.matches('style,link') || (record.type === 'childList' && [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node.nodeType === 1 && (node as Element).matches('style,link')))) {fullScan = true; changed = true; continue;}
                // 控件、导航与代码内部的时钟、hover 和编辑不影响正文。
                // 自身资格标记变化仍可重新启用正文，祖先保护边界内部无需扫描。
                const fixedProtected = 'nav,header,footer,button,form,pre,code,kbd,samp,input,textarea,select,svg,math';
                const updatesPinnedFont = record.type === 'attributes' && overrides.has(element as HTMLElement);
                if (!updatesPinnedFont && (element.closest(fixedProtected) || element.parentElement?.closest(excluded))) continue;
                if (record.type !== 'attributes' && element.closest(excluded)) continue;
                if (record.type === 'attributes' && record.attributeName === 'style') {
                    // 翻译布局观察器会写入高度、换行等属性；字体未变时不反复触发双方重扫。
                    const relevant = (value: string | null) => {
                        const style = document.createElement('span').style; style.cssText = value || '';
                        return Array.from(style).filter(name => ['font', 'font-family', 'display', 'visibility'].includes(name) || name.startsWith('--'))
                            .sort().map(name => `${name}:${style.getPropertyValue(name)}!${style.getPropertyPriority(name)}`).join(';');
                    };
                    if (relevant(record.oldValue) === relevant(element.getAttribute('style'))) continue;
                }
                changed = true;
                if (record.target.nodeType === 11) {dirty.add(element); continue;}
                if (record.type === 'childList' && !overrides.has(element as HTMLElement)) {
                    for (const node of Array.from(record.addedNodes)) {
                        if (node.nodeType === 1) dirty.add(node as Element);
                        else if (node.nodeType === 3) dirty.add(element);
                    }
                    if (Array.from(record.removedNodes).some(node => node.nodeType === 3)) dirty.add(element);
                } else dirty.add(element);
            }
            if (changed) schedule();
        });
        for (const root of [document, ...shadowRoots]) observer.observe(root, {subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: observedAttributes});
    };
    function schedule() {
        if (enabled && view && timer === undefined) timer = view.setTimeout(refresh, 60);
    }
    function scheduleFullScan() {fullScan = true; schedule();}
    const events = ['fluentread-shadow-root-attached', 'fluentread-translation-started', 'fluentread-translation-ended', 'load'];
    const setEnabled = (value: boolean) => {
        if (disposed || value === enabled || !view) return;
        enabled = value;
        if (value) {
            for (const event of events) document.addEventListener(event, scheduleFullScan, true);
            view.addEventListener('resize', scheduleFullScan);
            fullScan = true; refresh();
        } else {
            observer?.disconnect(); observer = undefined;
            if (timer !== undefined) view.clearTimeout(timer);
            timer = undefined;
            for (const event of events) document.removeEventListener(event, scheduleFullScan, true);
            view.removeEventListener('resize', scheduleFullScan);
            restore(); dirty.clear(); shadowRoots.clear(); coveredBranches = new WeakSet();
        }
    };
    return {setEnabled, dispose() {setEnabled(false); disposed = true;}};
}

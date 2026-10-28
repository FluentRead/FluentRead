/**
 * @file src/features/section-translation/content/remembered.ts
 * 文件职责：在命中用户保存的局部翻译规则时协调自动执行与一次性提醒，复用区域翻译引擎，不建立新的翻译队列。
 * 主要内容：无匹配规则时不创建观察器；匹配后合并 DOM 变更，以八毫秒时间片检查规则，监听规则路径经过的开放 ShadowRoot；自动执行串行且只处理待翻译内容，页面隐藏暂停派发，路由、规则变更和卸载取消旧任务；手动选择或恢复原文暂停本页自动处理，防止用户刚恢复就再次翻译。
 * 模块边界：依赖注入提供定位、翻译与提醒端口；本模块不访问存储、不绘制 UI、不解释凭据，也不修改浏览器路由。
 */
import {matchesSectionTranslationRule, type SectionTranslationRule} from '@/src/core/config/sectionTranslationRules';

export interface RememberedSectionPorts {
    document: Document;
    href(): string;
    rules(): readonly SectionTranslationRule[];
    enabled(): boolean;
    resolve(selectors: readonly (readonly string[])[], document: Document): Element[];
    translate(roots: readonly Element[], rule: SectionTranslationRule, signal: AbortSignal): Promise<void>;
    remind(count: number, translate: () => Promise<void>, dismiss: () => void, signal: AbortSignal): void;
}

const CHANGE_DELAY = 180;
const OWN_UI = '[data-fluent-read-ui], .fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper, [data-fr-translation-owned="true"]';

function ownNode(node: Node): boolean {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return Boolean(element?.closest(OWN_UI));
}

/** DOM contains 不穿过开放 ShadowRoot；按组合祖先限定文字变更是否属于已保存区域。 */
function within(root: Node, node: Node): boolean {
    for (let current: Node | null = node, depth = 0; current && depth < 512; depth += 1) {
        if (current === root) return true;
        current = current.parentNode ?? (current.nodeType === 11 ? (current as ShadowRoot).host : null);
    }
    return false;
}

export function createRememberedSectionRuntime(ports: RememberedSectionPorts, signal: AbortSignal): {
    refresh(): void;
    pause(): void;
} {
    let key = '';
    let href = '';
    let rules: SectionTranslationRule[] = [];
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    let running = false;
    let dirty = false;
    let paused = false;
    let dismissed = false;
    let reminderKey = '';
    let reminderController: AbortController | undefined;
    const observed = new Set<Node>();
    const rootsByRule = new Map<string, Element[]>();
    const hostsByRule = new Map<string, Element[]>();
    let trackedRoots = new Set<Node>();
    let trackedHosts: Element[] = [];

    const enabled = (): boolean => !signal.aborted && !controller.signal.aborted && !paused && ports.enabled()
        && ports.document.visibilityState !== 'hidden';
    const clearTimer = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const disconnect = (): void => { observer?.disconnect(); observer = undefined; observed.clear(); clearTimer(); };
    const clearReminder = (): void => { reminderController?.abort(); reminderController = undefined; reminderKey = ''; };
    const pause = (): void => {
        paused = true;
        controller.abort();
        disconnect();
        clearReminder();
    };
    const observe = (root: Node): void => {
        if (!observer || observed.has(root)) return;
        observed.add(root);
        // 属性过滤从保存路径提取；不观察 style 或任意业务计数，避免动画触发反复定位。
        const attributes = new Set(['id', 'class', 'hidden', 'aria-hidden']);
        for (const rule of rules) for (const path of rule.selectors) for (const selector of path) {
            for (const match of selector.matchAll(/\[([\w-]+)/gu)) attributes.add(match[1]);
        }
        observer.observe(root, {subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: [...attributes]});
    };
    const relevantMutation = (record: MutationRecord): boolean => {
        if (ownNode(record.target)) return false;
        let inside = false;
        for (let node: Node | null = record.target, depth = 0; node && depth < 512; depth += 1) {
            if (trackedRoots.has(node)) { inside = true; break; }
            node = node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
        }
        if (record.type === 'characterData') return inside;
        if (record.type === 'attributes') {
            if (inside || [...trackedRoots, ...trackedHosts].some(root => within(record.target, root))) return true;
            // 未定位的子区域可能因祖先锚点变化而出现；歧义也可能因旧锚点消失而解除。
            const target = record.target as Element;
            return rules.some(rule => rule.selectors.some(path => path.some(selector => {
                try {
                    if (target.matches(selector)) return true;
                    const attribute = record.attributeName;
                    if (!attribute) return false;
                    if ((attribute === 'hidden' || attribute === 'aria-hidden') && target.querySelector(selector)) return true;
                    if (!selector.includes(`[${attribute}`) && !(attribute === 'id' && selector.includes('#'))
                        && !(attribute === 'class' && selector.includes('.'))) return false;
                    const referenced = (input: string | null): boolean => input === ''
                        ? selector.includes('=""') || selector.includes("=''")
                        : Boolean(input && (selector.includes('\\') ||
                        [input, ...input.split(/\s+/u)].some(value => {
                            if (!value) return false;
                            if (selector.includes(`"${value}"`) || selector.includes(`'${value}'`)) return true;
                            if (attribute !== 'id' && attribute !== 'class') return false;
                            const literal = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
                            return new RegExp(`[.#]${literal}(?=$|[.#[:>\\s])`, 'u').test(selector);
                        })));
                    return referenced(record.oldValue) || referenced(target.getAttribute(attribute)) && Boolean(target.querySelector(selector));
                } catch { /* 无效选择器仍由定位器安全拒绝。 */ }
                return false;
            })));
        }
        const changed = [...record.addedNodes, ...record.removedNodes].filter(node => !ownNode(node));
        return changed.some(node => node.nodeType === 1 || inside);
    };
    const observePaths = (rule: SectionTranslationRule): void => {
        const hosts: Element[] = [];
        hostsByRule.set(rule.id, hosts);
        // 即使最终节点尚未出现，也观察已经存在的 host，以支持 ShadowRoot 内晚加载正文。
        for (const path of rule.selectors) {
            let root: Document | ShadowRoot = ports.document;
            for (const selector of path.slice(0, -1)) {
                let matches: NodeListOf<Element>;
                try { matches = root.querySelectorAll(selector); } catch { break; }
                if (matches.length !== 1 || !matches[0].shadowRoot) break;
                hosts.push(matches[0]);
                root = matches[0].shadowRoot;
                observe(root);
            }
        }
        trackedHosts = [...hostsByRule.values()].flat();
    };
    const resolve = (rule: SectionTranslationRule): Element[] => {
        observePaths(rule);
        const roots = ports.resolve(rule.selectors, ports.document);
        rootsByRule.set(rule.id, roots);
        trackedRoots = new Set([...rootsByRule.values()].flat());
        return roots;
    };
    const showReminder = (count: number, current: AbortController): void => {
        const nextKey = `${href}:${count}`;
        if (reminderKey === nextKey) return;
        clearReminder();
        reminderKey = nextKey;
        const reminder = new AbortController();
        reminderController = reminder;
        let busy = false;
        const translateReminders = async (): Promise<void> => {
            if (busy || reminder.signal.aborted || current !== controller || !enabled()) return;
            busy = true;
            try {
                for (const rule of rules.filter(rule => rule.mode === 'remind')) {
                    if (reminder.signal.aborted || !enabled() || controller !== current) return;
                    const roots = resolve(rule);
                    if (roots.length) await ports.translate(roots, rule, current.signal);
                }
            } finally { busy = false; }
        };
        ports.remind(count, translateReminders, () => { dismissed = true; clearReminder(); }, reminder.signal);
    };
    const run = async (): Promise<void> => {
        timer = undefined;
        if (!enabled()) return;
        running = true;
        dirty = false;
        const current = controller;
        let available = 0;
        const claimed: Element[] = [];
        let sliceStart = performance.now();
        try {
            for (const rule of rules) {
                if (!enabled() || current !== controller) return;
                const roots = resolve(rule).filter(root => !claimed.some(other => other === root || other.contains(root) || root.contains(other)));
                claimed.push(...roots);
                if (rule.mode === 'remind') available += roots.length;
                else if (roots.length) await ports.translate(roots, rule, current.signal);
                if (performance.now() - sliceStart >= 8) {
                    if (!enabled() || current !== controller) return;
                    await new Promise<void>(resolve => {
                        const finish = (): void => { clearTimeout(handle); current.signal.removeEventListener('abort', finish); resolve(); };
                        const handle = setTimeout(finish, 0);
                        current.signal.addEventListener('abort', finish, {once: true});
                    });
                    sliceStart = performance.now();
                }
            }
            if (current === controller) {
                // 同路由反复替换组件时释放已脱离的 ShadowRoot，避免观察器保留旧子树。
                const wanted = new Set<Node>([ports.document.documentElement]);
                for (const hosts of hostsByRule.values()) for (const host of hosts) { if (host.isConnected && host.shadowRoot) wanted.add(host.shadowRoot); }
                if ([...observed].some(root => !wanted.has(root))) {
                    observer?.disconnect(); observed.clear(); wanted.forEach(observe);
                }
                if (available && !dismissed && enabled()) showReminder(available, current);
                else clearReminder();
            }
        } catch { /* 翻译端口负责展示可重试错误；观察器不能形成未处理拒绝或自动重试循环。 */ }
        finally {
            running = false;
            if (dirty && enabled()) schedule();
        }
    };
    const schedule = (): void => {
        if (!enabled()) return;
        dirty = true;
        if (timer === undefined && !running) timer = setTimeout(() => { void run(); }, CHANGE_DELAY);
    };
    const startObservation = (): void => {
        if (!rules.length || !enabled()) return;
        observer = new MutationObserver(records => { if (records.some(relevantMutation)) schedule(); });
        observe(ports.document.documentElement);
        schedule();
    };
    const refresh = (): void => {
        if (signal.aborted) return;
        const nextHref = ports.href();
        const nextRules = ports.rules().filter(rule => rule.enabled && matchesSectionTranslationRule(rule, nextHref))
            .sort((a, b) => b.site.length - a.site.length);
        const nextKey = `${ports.enabled()}:${JSON.stringify(nextRules)}`;
        if (nextHref === href && nextKey === key) return;
        const routeChanged = nextHref !== href;
        controller.abort();
        disconnect();
        clearReminder();
        controller = new AbortController();
        if (routeChanged) { paused = false; dismissed = false; }
        href = nextHref;
        key = nextKey;
        rules = nextRules;
        rootsByRule.clear(); hostsByRule.clear(); trackedRoots.clear(); trackedHosts = [];
        startObservation();
    };
    ports.document.addEventListener('fluentread-route-change', refresh, {signal});
    ports.document.addEventListener('fluentread-translation-ended', pause, {signal});
    ports.document.addEventListener('fluentread-translation-started', pause, {signal});
    ports.document.addEventListener('visibilitychange', () => {
        if (signal.aborted) return;
        if (ports.document.visibilityState === 'hidden') {
            controller.abort(); disconnect(); clearReminder();
        } else if (!paused && rules.length && !observer) {
            controller.abort(); controller = new AbortController(); startObservation();
        }
    }, {signal});
    signal.addEventListener('abort', () => { controller.abort(); disconnect(); clearReminder(); }, {once: true});
    refresh();
    return {refresh, pause};
}

/**
 * @file src/features/full-page-translation/content/hoverRemountRecovery.ts
 * 文件职责：为 X 已确认的公开帖子正文提供受限的在途悬浮重挂恢复。
 * 主要内容：仅在请求期间短暂观察节点换代；预存有界祖先路径，绑定唯一帖子链接、正文结构和精确文本槽，分批替换还须保持同一父节点与兄弟边界。
 * 模块边界：不复用旧译文、不发起请求、不改变宿主 DOM；不推断跨文档、跨路由或身份不唯一的节点。
 */
import {collectLiveTranslationTextSlots, getCurrentTranslationCore, type TranslationCandidate} from '@/src/core/translation/public';
import {getTranslationSourceStructureSignature, isTranslationSourceStructureOverflow} from './state';
import {nodeAtPath} from './bilingualRemountMatching';

const MAX_RECORDS = 128;
const MAX_POST_LINKS = 2048;
const MAX_POST_ELEMENTS = 4096;
// 限额覆盖实际遍历而不是 querySelectorAll 的结果长度；超限时拒绝恢复。
const MAX_SCAN_NODES = 16_384;
const MAX_TOTAL_SCAN_NODES = MAX_SCAN_NODES * 3;
const MAX_SCAN_TEXT = 262_144;
const MAX_URL_LENGTH = 8_192;
const MAX_SOURCE_IDENTITIES = 8;
const MAX_ANCESTORS = 64;
const MAX_ANCESTOR_CHILDREN = 16_384;
const WATCH_MS = 30_000;
const REPLACEMENT_GRACE_MS = 1_000;
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
interface ScanBudget {nodes: number; text: number; urls: number}
interface ScanEntry {node: Node; inMain: boolean; inMainArticle: boolean; article: Element | null}

function scanBudget(): ScanBudget {return {nodes: MAX_TOTAL_SCAN_NODES, text: MAX_SCAN_TEXT, urls: MAX_SCAN_TEXT};}

/** 分片前先检查剩余预算，避免一次宽节点构造无界列表；false 统一表示不安全。 */
function scan(root: Node, budget: ScanBudget, visit: (entry: ScanEntry) => boolean, nodeCost = 1): boolean {
    const pending: ScanEntry[] = [{node: root, inMain: false, inMainArticle: false, article: null}];
    let remaining = MAX_SCAN_NODES;
    while (pending.length) {
        const entry = pending.pop()!;
        if ((budget.nodes -= nodeCost) < 0) return false;
        remaining -= 1;
        if (!visit(entry)) return false;
        const element = entry.node.nodeType === 1 ? entry.node as Element : null;
        const inMain = entry.inMain || element?.localName === 'main';
        const inMainArticle = entry.inMainArticle || (entry.inMain && element?.localName === 'article');
        const article = element?.localName === 'article' ? element : entry.article;
        for (let child = entry.node.lastChild; child; child = child.previousSibling) {
            if (pending.length >= Math.min(budget.nodes, remaining)) {budget.nodes = -1; return false;}
            pending.push({node: child, inMain, inMainArticle, article});
        }
    }
    return true;
}

function isPostLink(element: Element): boolean {
    return element.localName === 'a' && element.hasAttribute('data-base-ui-tooltip-trigger') && element.hasAttribute('href');
}

function postUrl(element: Element, base: string, budget: ScanBudget): URL | null {
    const href = element.getAttribute('href');
    if (href === null || href.length > MAX_URL_LENGTH || base.length > MAX_URL_LENGTH) return null;
    budget.urls -= href.length + base.length;
    if (budget.urls < 0) return null;
    try {return new URL(href, base);} catch {return null;}
}

const SIGNATURE_OMITTED_TAGS = new Set(['iframe', 'object', 'script', 'style', 'template', 'xmp']);

/** 与结构签名同样排除自有节点、tooltip 和不可输出标签；实际身份仍以完整签名为准。 */
function boundedText(root: Node, budget = scanBudget()): string | null {
    let result = '';
    const omitted = new WeakSet<Node>();
    const complete = scan(root, budget, ({node}) => {
        let ignored = node !== root && node.parentNode !== null && omitted.has(node.parentNode);
        if (!ignored && node !== root && node.nodeType === 1) {
            const element = node as Element;
            ignored = SIGNATURE_OMITTED_TAGS.has(element.localName) || element.getAttribute('data-fr-translation-owned') === 'true'
                || element.getAttribute('role') === 'tooltip';
            if (!ignored && element.classList.contains('tooltip')) {
                for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
                    if (--budget.nodes < 0) return false;
                    if (child.classList.contains('tooltip-inner')) {ignored = true; break;}
                }
            }
        }
        if (ignored) omitted.add(node);
        if (node.nodeType === 3 || node.nodeType === 4) {
            const text = (node as Text).data;
            budget.text -= text.length;
            if (budget.text < 0) return false;
            // 签名折叠普通空白；统一折叠 pre 空白只会产生保守的额外精确比较。
            if (!ignored && node.nodeType === 3) result += text.replace(/[\s\u3000]+/gu, ' ');
        }
        return true;
    });
    return complete ? result : null;
}

/** 粗筛文本一致不代表身份一致；之后仍须比较完整结构和可译槽。 */
function sameText(root: Node, expected: string, budget: ScanBudget): boolean {
    const text = boundedText(root, budget);
    return text !== null && text === expected;
}

function postIdentity(article: HTMLElement, document: Document, budget = scanBudget()): string | null {
    const urls: string[] = [];
    const base = document.location.href;
    let count = 0;
    const complete = scan(article, budget, ({node, article: nearestArticle}) => {
        if (node.nodeType !== 1 || !isPostLink(node as Element)) return true;
        if (++count > MAX_POST_LINKS) return false;
        if (nearestArticle !== article) return true;
        const url = postUrl(node as Element, base, budget);
        if (!url) return false;
        if (url.origin === document.location.origin && /^\/[^/]+\/status\/\d+\/?$/u.test(url.pathname)) {
            urls.push(url.origin + url.pathname.replace(/\/$/u, ''));
            if (urls.length > 1) return false;
        }
        return true;
    });
    return complete && urls.length === 1 ? urls[0]! : null;
}

function postIsUnique(document: Document, expected: string, budget = scanBudget()): boolean {
    const base = document.location.href;
    let count = 0;
    let links = 0;
    const complete = scan(document, budget, ({node}) => {
        if (node.nodeType !== 1 || !isPostLink(node as Element)) return true;
        if (++links > MAX_POST_LINKS) return false;
        const url = postUrl(node as Element, base, budget);
        if (!url) return false;
        if (url.origin + url.pathname.replace(/\/$/u, '') === expected && ++count > 1) return false;
        return true;
    });
    return complete && count === 1;
}

function sourceIdentity(candidate: TranslationCandidate): string | null {
    const element = candidate.element;
    const core = getCurrentTranslationCore(candidate.scope);
    const signature = getTranslationSourceStructureSignature(element, false, undefined, candidate.scope);
    if (isTranslationSourceStructureOverflow(signature)) return null;
    const slots = collectLiveTranslationTextSlots(element, core.shouldStayOriginal, undefined, {protectedElement: element});
    return JSON.stringify([signature, slots.map(({prefix, source, suffix}) => [prefix, source, suffix])]);
}

function sourceIsUnique(document: Document, candidate: TranslationCandidate, source: string, text: string,
    budget = scanBudget()): boolean {
    let count = 0;
    let elements = 0;
    let identities = 0;
    const complete = scan(document, budget, ({node, inMainArticle}) => {
        if (node.nodeType !== 1 || !inMainArticle || (node as Element).localName !== candidate.element.localName) return true;
        if (++elements > MAX_POST_ELEMENTS) return false;
        // sameText 消耗同一预算；预算不足也必须拒绝整个判定。
        if (!sameText(node, text, budget)) return budget.nodes >= 0 && budget.text >= 0;
        if (++identities > MAX_SOURCE_IDENTITIES) return false;
        if (sourceIdentity({...candidate, element: node as HTMLElement}) === source && ++count > 1) return false;
        return true;
    });
    return complete && count === 1;
}

/**
 * 起点的链接与正文唯一性共享一次完整文档遍历，仍为旧的两次遍历逐节点计费。
 * 先验完整文档中的帖子链接，再按原顺序复核所有 main/article 正文，不缩小重复检查范围。
 */
function initialIdentityIsUnique(document: Document, candidate: TranslationCandidate, source: string,
    text: string, post: string, budget: ScanBudget, seen: WeakSet<Node>): boolean {
    const base = document.location.href;
    const candidates: HTMLElement[] = [];
    let links = 0, posts = 0;
    // 为旧流程的第二次文档遍历逐节点预留预算，不能因合并而接受原本超限的页面。
    const complete = scan(document, budget, ({node, inMainArticle}) => {
        seen.add(node);
        if (node.nodeType !== 1) return true;
        const element = node as HTMLElement;
        if (isPostLink(element)) {
            if (++links > MAX_POST_LINKS) return false;
            const url = postUrl(element, base, budget);
            if (!url) return false;
            if (url.origin + url.pathname.replace(/\/$/u, '') === post && ++posts > 1) return false;
        }
        if (inMainArticle && element.localName === candidate.element.localName) {
            if (candidates.length >= MAX_POST_ELEMENTS) return false;
            candidates.push(element);
        }
        return true;
    }, 2);
    if (!complete || posts !== 1) return false;
    let count = 0, identities = 0;
    for (const element of candidates) {
        if (!sameText(element, text, budget)) {
            if (budget.nodes < 0 || budget.text < 0) return false;
            continue;
        }
        if (++identities > MAX_SOURCE_IDENTITIES) return false;
        if (sourceIdentity({...candidate, element}) === source && ++count > 1) return false;
    }
    return count === 1;
}

interface RemovedAncestor {
    readonly parent: Node;
    readonly ownerPath: readonly number[];
    readonly articlePath: readonly number[] | null;
}

interface PendingReplacement {
    readonly parent: Node;
    readonly previous: Node | null;
    readonly next: Node | null;
    readonly identity: RemovedAncestor;
}

interface ReplacementLocation extends PendingReplacement { readonly root: Node }

/** 已选中的替换根仍须占据与旧根相同的兄弟位置。 */
function remainsAtOriginalLocation({root, parent, previous, next}: ReplacementLocation): boolean {
    return root.parentNode === parent && root.previousSibling === previous && root.nextSibling === next &&
        (!previous || previous.parentNode === parent) && (!next || next.parentNode === parent);
}

/** 间隔期间同一父节点的前后兄弟必须仍然紧邻，不能用文字推测位置。 */
function isOriginalGap({parent, previous, next}: PendingReplacement): boolean {
    return (previous ? previous.parentNode === parent && previous.nextSibling === next : parent.firstChild === next)
        && (next ? next.parentNode === parent && next.previousSibling === previous : parent.lastChild === previous);
}

/** 在宿主拆散旧树之前冻结路径；只收集 owner 至 main 的有限父链。 */
function captureAncestors(owner: HTMLElement, article: HTMLElement): Map<Node, RemovedAncestor> | null {
    const main = article.closest('main');
    if (!main) return null;
    const ancestors = new Map<Node, RemovedAncestor>();
    let root: Node = owner;
    let ownerPath: number[] = [];
    let articlePath: number[] | null = null;
    let remainingChildren = MAX_ANCESTOR_CHILDREN;
    for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
        if (root === article) articlePath = [];
        const parent = root.parentNode;
        if (!parent) return null;
        ancestors.set(root, {parent, ownerPath: [...ownerPath], articlePath: articlePath && [...articlePath]});
        if (root === main) return ancestors;
        const children = parent.childNodes;
        if (children.length > remainingChildren) return null;
        remainingChildren -= children.length;
        const index = Array.prototype.indexOf.call(children, root) as number;
        if (index < 0) return null;
        ownerPath = [index, ...ownerPath];
        if (articlePath) articlePath = [index, ...articlePath];
        root = parent;
    }
    return null;
}

export interface HoverRemountRecovery {
    cancel(): void;
    ownsOwner(element: HTMLElement): boolean;
    waitForReplacement(): Promise<boolean>;
    finish(stale: boolean): TranslationCandidate | null;
}

/** 一次手势只保存一个候选；分批替换须在有界时间内填回同一父节点的原位置。 */
export function trackXHoverRemount(candidate: TranslationCandidate, _x: number, _y: number,
    isCurrent: () => boolean, onCancel: () => void = () => {}): HoverRemountRecovery | null {
    const owner = candidate.element;
    const document = owner.ownerDocument;
    const view = document.defaultView;
    if (!view || !owner.isConnected || !X_HOSTS.has(document.location.hostname) || candidate.kind !== 'content'
        || candidate.nodes?.length || candidate.visualRange || candidate.manualChunk || candidate.allowTopLevelApplicationShell) return null;
    const article = owner.closest<HTMLElement>('article');
    if (!article || !article.contains(owner)) return null;
    const ancestors = captureAncestors(owner, article);
    if (!ancestors) return null;
    // 起点上已经连接的节点不能被证明是本次重挂新产生的替换。
    // 复用原有的全页唯一性扫描记录它们，避免另外遍历一遍文档。
    const seenHistory = new WeakSet<Node>();
    const initialBudget = scanBudget();
    const oldPost = postIdentity(article, document, initialBudget);
    const sourceText = boundedText(owner, initialBudget);
    if (sourceText === null) return null;
    const source = sourceIdentity(candidate);
    if (!oldPost || source === null ||
        !initialIdentityIsUnique(document, candidate, source, sourceText, oldPost, initialBudget, seenHistory)) return null;
    const route = document.location.href;
    let current = true;
    let replacement: HTMLElement | null = null;
    let replacementLocation: ReplacementLocation | null = null;
    let pending: PendingReplacement | null = null;
    // 记录观察期间的增删树，拒绝把先前已连接的宿主节点认作新生成的替换。
    // 每条回调先冻结仍可见的后代；临时观察产生的后代移除记录也进入同一历史。
    const historyBudget = scanBudget();
    historyBudget.nodes = MAX_SCAN_NODES;
    let timer: number;
    let graceTimer: number | undefined;
    let waiting: Promise<boolean> | undefined;
    let resolveWaiting: ((matched: boolean) => void) | undefined;
    const settleWaiting = (matched: boolean) => {const resolve = resolveWaiting; resolveWaiting = undefined; resolve?.(matched);};
    const startGrace = () => {if (graceTimer === undefined) graceTimer = view.setTimeout(cancel, REPLACEMENT_GRACE_MS);};
    const clearGrace = () => {if (graceTimer !== undefined) view.clearTimeout(graceTimer); graceTimer = undefined;};
    const interaction = (event: Event) => {if (event.isTrusted) cancel();};
    const routeChanged = () => {if (document.location.href !== route) cancel();};
    const events: Array<[EventTarget, string, EventListener]> = [
        [document, 'pointerdown', interaction], [document, 'scroll', interaction],
        [document, 'visibilitychange', interaction], [document, 'fluentread-route-change', routeChanged],
        [view, 'keydown', interaction], [view, 'blur', interaction], [view, 'pagehide', interaction],
        [view, 'popstate', routeChanged], [view, 'hashchange', routeChanged],
    ];
    const cancel = () => {
        if (!current) return;
        current = false;
        observer.disconnect();
        view.clearTimeout(timer);
        clearGrace();
        for (const [target, type, listener] of events) target.removeEventListener(type, listener, true);
        settleWaiting(false);
        onCancel();
    };
    const tryReplacement = (added: readonly Node[], identity: RemovedAncestor): boolean => {
        const {ownerPath, articlePath} = identity;
        const matches: HTMLElement[] = [];
        // 一个 observer 批次共享预算，不能让多个新增根重复扫描整篇文档。
        const budget = scanBudget();
        for (const addedRoot of added) {
            const next = nodeAtPath(addedRoot, ownerPath) as HTMLElement | null;
            if (!next || next.nodeType !== 1 || !next.isConnected || next.ownerDocument !== document) continue;
            const nextArticle = articlePath ? nodeAtPath(addedRoot, articlePath) as HTMLElement | null : article;
            if (!nextArticle || next.closest('article') !== nextArticle) continue;
            const post = postIdentity(nextArticle, document, budget);
            if (!post || post !== oldPost || !postIsUnique(document, post, budget)) continue;
            const nextCandidate = {...candidate, element: next};
            if (sameText(next, sourceText, budget) && sourceIdentity(nextCandidate) === source &&
                sourceIsUnique(document, nextCandidate, source, sourceText, budget)) matches.push(next);
        }
        if (matches.length !== 1) return false;
        replacement = matches[0]!;
        pending = null;
        clearGrace();
        settleWaiting(true);
        return true;
    };
    const neverSeen = (root: Node): boolean => scan(root, scanBudget(), ({node}) => !seenHistory.has(node));
    const rememberAdded = (records: readonly MutationRecord[], except?: Node, acceptedRoot?: Node): boolean => {
        for (const record of records) {
            for (const root of record.addedNodes) {
                if (root === except) continue;
                // 接受后的新徽标等不属于先前宿主身份；但此前见过的节点移入仍须拒绝。
                if (acceptedRoot?.contains(root)) {if (!neverSeen(root)) return false;}
                else if (!scan(root, historyBudget, ({node}) => {seenHistory.add(node); return true;})) return false;
            }
        }
        return true;
    };
    const processRecords = (records: MutationRecord[]) => {
        if (!current) return;
        if (records.length > MAX_RECORDS) { cancel(); return; }
        let removedCount = 0, addedCount = 0;
        for (const record of records) {
            removedCount += record.removedNodes.length;
            addedCount += record.addedNodes.length;
            if (removedCount > MAX_RECORDS || addedCount > MAX_RECORDS) {cancel(); return;}
            for (const root of record.removedNodes) {
                if (!scan(root, historyBudget, ({node}) => {seenHistory.add(node); return true;})) {cancel(); return;}
            }
        }
        if (replacement) {
            if (!replacement.isConnected || !replacementLocation || !remainsAtOriginalLocation(replacementLocation) ||
                !rememberAdded(records, undefined, replacementLocation.root) || !neverSeen(replacementLocation.root)) cancel();
            return;
        }
        if (pending) {
            const changes = records.filter(record => record.target === pending!.parent);
            if (!changes.length) {if (!rememberAdded(records)) cancel(); return;}
            if (!pending.parent.isConnected || pending.parent.ownerDocument !== document || view.document !== document ||
                document.location.href !== route || !isCurrent() || changes.length !== 1) { cancel(); return; }
            const change = changes[0]!;
            if (change.removedNodes.length || change.addedNodes.length !== 1 ||
                change.previousSibling !== pending.previous || change.nextSibling !== pending.next) { cancel(); return; }
            const added = change.addedNodes[0]!;
            replacementLocation = {...pending, root: added};
            if (added.parentNode !== pending.parent || added.previousSibling !== pending.previous || added.nextSibling !== pending.next ||
                !rememberAdded(records, added) || !neverSeen(added) || !tryReplacement([added], pending.identity)) cancel();
            return;
        }
        // 单条 mutation 也可能包含大量节点；先限额再遍历，避免批量复制或无界扫描。
        const matching: Array<{record: MutationRecord; identity: RemovedAncestor}> = [];
        let detachedAncestor = false;
        for (const record of records) {
            // 被移除的 MAIN 可能在同一批回调前已被宿主拆散，不能再依赖 contains(owner)。
            // 只信任请求开始时记录的祖先、仍连接的原父节点及其同批替换。
            for (const root of record.removedNodes) {
                const identity = ancestors.get(root);
                if (identity && identity.parent === record.target) {
                    if (record.target.isConnected) matching.push({record, identity});
                    else detachedAncestor = true;
                }
            }
        }
        if (!matching.length) {if (detachedAncestor || !rememberAdded(records)) cancel(); return;}
        if (matching.length !== 1 || owner.isConnected || view.document !== document ||
            !isCurrent() || document.location.href !== route) { cancel(); return; }
        const {record, identity} = matching[0]!;
        const changes = records.filter(item => item.target === record.target);
        if (record.removedNodes.length !== 1 || record.target.ownerDocument !== document || changes[0] !== record) {cancel(); return;}
        // 同批替换也必须填回移除位置：同一父级上的其他新增节点不能凭文本相同被认作旧 owner。
        const addition = record.addedNodes.length ? record : changes.length === 2 ? changes[1]! : undefined;
        if (addition) {
            if ((addition === record ? changes.length !== 1 : changes.length !== 2 || addition.removedNodes.length !== 0) ||
                addition.addedNodes.length !== 1 || addition.previousSibling !== record.previousSibling ||
                addition.nextSibling !== record.nextSibling) {cancel(); return;}
            const added = addition.addedNodes[0]!;
            replacementLocation = {parent: record.target, previous: record.previousSibling,
                next: record.nextSibling, identity, root: added};
            if (added.parentNode !== record.target || added.previousSibling !== record.previousSibling ||
                added.nextSibling !== record.nextSibling || !rememberAdded(records, added) || !neverSeen(added) ||
                !tryReplacement([added], identity)) cancel();
            return;
        }
        if (changes.length !== 1) {cancel(); return;}
        if (!rememberAdded(records)) {cancel(); return;}
        pending = {parent: record.target, previous: record.previousSibling ?? null, next: record.nextSibling ?? null, identity};
        if (view.document !== document || pending.parent.ownerDocument !== document || !isOriginalGap(pending)) {cancel(); return;}
        startGrace();
    };
    const observer = new view.MutationObserver(processRecords);
    observer.observe(document.documentElement, {subtree: true, childList: true});
    for (const [target, type, listener] of events) target.addEventListener(type, listener, true);
    timer = view.setTimeout(cancel, WATCH_MS);
    return {
        cancel,
        ownsOwner(element) {
            // 新 owner 可在 MutationObserver 回调前被用户立即操作；先同步消费已入队记录，
            // 以相同的身份与位置校验识别它，避免旧令牌越过新的翻译或恢复意图。
            if (current && element !== owner && element !== replacement) {
                const records = observer.takeRecords();
                if (records.length) processRecords(records);
            }
            return element === owner || element === replacement;
        },
        waitForReplacement() {
            if (!current) return Promise.resolve(false);
            if (replacement?.isConnected) return Promise.resolve(true);
            if (!waiting) waiting = new Promise<boolean>(resolve => {resolveWaiting = resolve; startGrace();});
            return waiting;
        },
        finish(stale) {
            // 宿主可能在同一任务中移动节点再移回原位；最终 DOM 不会揭示排队的迁移记录。
            if (current) {
                const records = observer.takeRecords();
                if (records.length) processRecords(records);
            }
            const next = replacement;
            const usable = current && stale && view.document === document && isCurrent() && document.location.href === route && !owner.isConnected
                && next?.isConnected && next.ownerDocument === document && next.matches(':hover') && replacementLocation !== null
                && remainsAtOriginalLocation(replacementLocation) && neverSeen(replacementLocation.root);
            if (!usable || !next) {cancel(); return null;}
            const nextArticle = next.closest<HTMLElement>('article');
            const budget = scanBudget();
            const post = nextArticle && postIdentity(nextArticle, document, budget);
            const nextCandidate = {...candidate, element: next};
            const accepted = post === oldPost && postIsUnique(document, post, budget) && sameText(next, sourceText, budget) && sourceIdentity(nextCandidate) === source
                && sourceIsUnique(document, nextCandidate, source, sourceText, budget);
            cancel();
            return accepted ? nextCandidate : null;
        },
    };
}

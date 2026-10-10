/**
 * @file src/features/full-page-translation/content/sourceStabilityGate.ts
 * 文件职责：把来源稳定性判定接入会话调度，并拥有可取消的安静窗口定时器。
 * 主要内容：暂停动态来源请求、按最新候选和当前视口重新调度；以活父级的有界结构槽和弱引用交接已断连候选的来源历史，清理会话与路由切换后的定时器。
 * 模块边界：通过端口调用 runtime 的候选发现与队列，不直接管理译文 DOM、provider 或配置；纯来源判定由 sourceStability.ts 提供。
 */
import {getTranslationCandidateKey, type TranslationCandidate} from '@/src/core/translation/public';
import {FULL_PAGE_PREFETCH_MARGIN_PX} from './fullPagePriority';
import {createTranslationSourceHistory, observeTranslationSource, TRANSLATION_SOURCE_MAX_QUIET_MS, type SourceHistory} from './sourceStability';

const SOURCE_REPLACEMENT_SLOT_LIMIT = 64;
const SOURCE_REPLACEMENT_TEXT_LIMIT = 8192;
interface ReplacementSourceSlot {
    identity: WeakRef<Node>;
    owner: WeakRef<HTMLElement>;
    history: SourceHistory;
    observedAt: number;
    siblings: WeakSet<Node>;
}

/** 只扫描有界直属节点，并将候选语义包含在槽身份里；不按全局文本合并。 */
function replacementSlot(candidate: TranslationCandidate, identity: Node): {parent: Node; key: string} | null {
    const parent = identity.parentNode;
    if (!parent?.isConnected || !candidate.element.isConnected) return null;
    const children = parent.childNodes;
    // 大父级无法完整记录已有邻居，保守跳过，防止扫描范围外的旧节点移位串历史。
    if (children.length > SOURCE_REPLACEMENT_SLOT_LIMIT) return null;
    // identity.parentNode 保证它是直属子节点，扫描长度已被上方限制。
    const index = Array.prototype.indexOf.call(children, identity) as number;
    const owner = candidate.element;
    const shape = identity.nodeType === 1 ? (identity as Element).localName : '#text';
    return {parent, key: JSON.stringify([index, identity.nodeType, shape, owner.localName, owner.id,
        owner.getAttribute('role'), candidate.kind, candidate.scope, candidate.reason, candidate.nodes?.length ?? 0])};
}

interface SourceStabilitySession {
    translationMode: string;
    scheduled: Map<Node, TranslationCandidate>;
    candidateAnchors?: ReadonlyMap<Node, HTMLElement>;
    unchangedCandidates: WeakMap<Node, unknown>;
    lifecycleRetries: WeakMap<Node, unknown>;
}

interface SourceStabilityPorts<T> {
    isCurrent: (session: T) => boolean;
    resolve: (candidate: TranslationCandidate) => TranslationCandidate | null;
    discover: (session: T, candidate: TranslationCandidate) => void;
    source: (candidate: TranslationCandidate) => string;
    queue: (session: T, key: Node, candidate: TranslationCandidate, source: string) => void;
    drain: (session: T) => void;
}

/** 复用曾经可见的锚点前检查当前位置，避免把离屏来源提前请求。 */
export function isAnchorNearViewport(anchor: HTMLElement): boolean {
    try {
        const rect = anchor.getBoundingClientRect();
        const width = window.innerWidth || document.documentElement.clientWidth;
        const height = window.innerHeight || document.documentElement.clientHeight;
        return width > 0 && height > 0 && rect.width > 0 && rect.height > 0 &&
            rect.right > 0 && rect.left < width &&
            rect.bottom > -FULL_PAGE_PREFETCH_MARGIN_PX &&
            rect.top < height + FULL_PAGE_PREFETCH_MARGIN_PX;
    } catch {
        return false;
    }
}

export class TranslationSourceStabilityGate<T extends SourceStabilitySession> {
    private history = createTranslationSourceHistory();
    private replacementSlots = new WeakMap<Node, Map<string, ReplacementSourceSlot>>();
    private readonly timers = new Map<T, Map<Node, number>>();

    constructor(private readonly ports: SourceStabilityPorts<T>) {}

    private observe(candidate: TranslationCandidate, identity: Node, source: string, now: number) {
        const slot = replacementSlot(candidate, identity);
        // 有界槽也不能保留任意大的已删除正文；超大来源会中断该槽的交接链。
        if (source.length > SOURCE_REPLACEMENT_TEXT_LIMIT) {
            const parent = identity.parentNode;
            const slots = parent ? this.replacementSlots.get(parent) : undefined;
            if (slot) slots?.delete(slot.key);
            slots?.forEach((record, key) => {
                if (record.identity.deref() === identity) slots.delete(key);
            });
            return observeTranslationSource(this.history, identity, source, now);
        }
        if (slot && !this.history.has(identity)) {
            const previous = this.replacementSlots.get(slot.parent)?.get(slot.key);
            if (previous && !previous.siblings.has(identity) && now - previous.observedAt <= TRANSLATION_SOURCE_MAX_QUIET_MS) {
                const oldIdentity = previous.identity.deref(), oldOwner = previous.owner.deref();
                if (!oldIdentity?.isConnected && (oldOwner === candidate.element || !oldOwner?.isConnected)) {
                    this.history.set(identity, {...previous.history});
                    // 交接后旧候选已经断连，所有会话的旧回调都失去所有权。
                    if (oldIdentity) this.timers.forEach((pending, session) => {
                        const timer = pending.get(oldIdentity);
                        if (timer !== undefined) {
                            window.clearTimeout(timer);
                            pending.delete(oldIdentity);
                            if (!pending.size) this.timers.delete(session);
                        }
                    });
                }
            }
        }
        const decision = observeTranslationSource(this.history, identity, source, now);
        if (slot) {
            const slots = this.replacementSlots.get(slot.parent) ?? new Map<string, ReplacementSourceSlot>();
            slots.delete(slot.key);
            if (slots.size >= SOURCE_REPLACEMENT_SLOT_LIMIT) slots.delete(slots.keys().next().value!);
            slots.set(slot.key, {identity: new WeakRef(identity), owner: new WeakRef(candidate.element),
                history: {...this.history.get(identity)!}, observedAt: now, siblings: new WeakSet(Array.from(slot.parent.childNodes))});
            this.replacementSlots.set(slot.parent, slots);
        }
        return decision;
    }

    /** 返回 true 表示当前来源暂时或持续保持原文。 */
    blocks(candidate: TranslationCandidate, source: string, session?: T): boolean {
        const identity = getTranslationCandidateKey(candidate);
        const stability = this.observe(candidate, identity, source, Date.now());
        const timers = session ? this.timers.get(session) : undefined;
        const currentTimer = timers?.get(identity);
        if (currentTimer !== undefined) {
            window.clearTimeout(currentTimer);
            timers!.delete(identity);
            if (!timers!.size) this.timers.delete(session!);
        }
        if (stability.kind === 'ready') return false;
        if (stability.kind === 'settling' && session) {
            const pending = timers ?? new Map<Node, number>();
            this.timers.set(session, pending);
            const history = this.history;
            const observed = history.get(identity)!;
            const observedSource = observed.source, changedAt = observed.changedAt;
            const timer = window.setTimeout(() => {
                // 外部端口和宿主布局读取可同步重入 reset/dispose/blocks；运行中的
                // timer 仍须拥有槽位，才能拒绝旧路由、旧来源并保留新一代 timer。
                const ownsTimer = () => this.timers.get(session) === pending && pending.get(identity) === timer;
                const isCurrent = () => this.ports.isCurrent(session) && ownsTimer() && identity.isConnected &&
                    this.history === history && observed.source === observedSource && observed.changedAt === changedAt;
                try {
                    if (!isCurrent()) return;
                    session.unchangedCandidates.delete(identity);
                    session.lifecycleRetries.delete(identity);
                    const fresh = this.ports.resolve(candidate);
                    if (!fresh || !isCurrent() || !fresh.element.isConnected) return;
                    this.ports.discover(session, fresh);
                    if (!isCurrent()) return;
                    const key = getTranslationCandidateKey(fresh);
                    const scheduled = session.scheduled.get(key);
                    // discover 可能保留共享 key 的优先候选；读取它的来源和几何。
                    if (!scheduled || !scheduled.element.isConnected) return;
                    const source = this.ports.source(scheduled);
                    if (!isCurrent() || session.scheduled.get(key) !== scheduled) return;
                    const anchor = session.candidateAnchors?.get(key) ?? scheduled.element;
                    if (session.translationMode !== 'all' && (!anchor.isConnected || !isAnchorNearViewport(anchor))) return;
                    if (!isCurrent() || !scheduled.element.isConnected || session.scheduled.get(key) !== scheduled) return;
                    this.ports.queue(session, key, scheduled, source);
                    if (isCurrent()) this.ports.drain(session);
                } finally {
                    if (ownsTimer()) {
                        pending.delete(identity);
                        if (!pending.size) this.timers.delete(session);
                    }
                }
            }, stability.delay);
            pending.set(identity, timer);
        }
        return true;
    }

    dispose(session: T): void {
        this.timers.get(session)?.forEach(timer => window.clearTimeout(timer));
        this.timers.delete(session);
    }

    reset(): void {
        this.timers.forEach((_timers, session) => this.dispose(session));
        this.history = createTranslationSourceHistory();
        this.replacementSlots = new WeakMap();
    }
}

/**
 * @file src/features/full-page-translation/content/hoverScheduler.ts
 * 文件职责：为共享网页翻译引擎管理悬浮候选的停留计时、冻结配置与取消生命周期。
 * 主要内容：同一真实候选继续移动时只更新坐标并保留首次截止时间；跨段、视觉范围、内联节点或方案变化时重新计时，到期复验当前命中防止滚动后翻译新内容；仅新停留捕获请求配置，零延迟沿用下一任务单次解析，保留浏览器让步。
 * 模块边界：只拥有短暂候选和定时器，通过注入端口解析、检查与派发；不监听网页事件、不读取全局配置、不创建 provider 请求或操作译文 DOM。
 */
import {getTranslationCandidateKey, type TranslationCandidate, type TranslationScope} from '@/src/core/translation/public';
import type {FullPageTranslationConfigSnapshot, PageTranslationConfigOverrides} from './translationConfigSnapshot';

export type HoverTranslationInvocation = PageTranslationConfigOverrides & {
    scope?: TranslationScope;
    delayMs?: number;
    continuous?: boolean;
};

interface PendingHoverTranslation {
    timer: ReturnType<typeof setTimeout>;
    candidate: TranslationCandidate | undefined;
    mouseX: number;
    mouseY: number;
    scope: TranslationScope;
    continuous: boolean;
    delayMs: number;
    invocationIdentity: string;
}

interface HoverTranslationSchedulerPorts {
    currentScope: () => TranslationScope;
    resolveCandidate: (mouseX: number, mouseY: number, scope: TranslationScope) => TranslationCandidate | null;
    captureConfig: (overrides: PageTranslationConfigOverrides) => FullPageTranslationConfigSnapshot;
    checkConfig: (snapshot: FullPageTranslationConfigSnapshot) => boolean;
    noteGesture: () => void;
    translate: (candidate: TranslationCandidate, snapshot: FullPageTranslationConfigSnapshot, continuous: boolean) => void;
}

/** 宿主相同仍可能是不同内联段或视觉文字块；延迟不能跨越这种候选变化。 */
function isSameHoverTranslationCandidate(previous: TranslationCandidate, current: TranslationCandidate): boolean {
    if (previous.element !== current.element || getTranslationCandidateKey(previous) !== getTranslationCandidateKey(current)
        || previous.kind !== current.kind || previous.scope !== current.scope || previous.reason !== current.reason
        || previous.adapterId !== current.adapterId || previous.allowTopLevelApplicationShell !== current.allowTopLevelApplicationShell
        || previous.sourceLine !== current.sourceLine || previous.manualChunk !== current.manualChunk
        || previous.nodes?.length !== current.nodes?.length
        || previous.nodes?.some((node, index) => node !== current.nodes?.[index])) return false;
    const first = previous.visualRange, second = current.visualRange;
    return first && second
        ? first.startContainer === second.startContainer && first.startOffset === second.startOffset
            && first.endContainer === second.endContainer && first.endOffset === second.endOffset
            && previous.visualSourceText === current.visualSourceText
        : first === second;
}

function invocationIdentity(overrides: PageTranslationConfigOverrides): string {
    return JSON.stringify([overrides.profileId, overrides.service, overrides.model,
        overrides.targetLanguage, overrides.displayMode, overrides.glossaryIds]);
}

export class HoverTranslationScheduler {
    private pending: PendingHoverTranslation | undefined;

    constructor(private readonly ports: HoverTranslationSchedulerPorts) {}

    cancel(): void {
        if (!this.pending) return;
        clearTimeout(this.pending.timer);
        this.pending = undefined;
    }

    handle(mouseX: number, mouseY: number, invocation: HoverTranslationInvocation = {}): void {
        const {delayMs = 0, continuous = false, scope = this.ports.currentScope(), ...overrides} = invocation;
        if (continuous) this.ports.noteGesture();
        const candidate = delayMs > 0 ? this.ports.resolveCandidate(mouseX, mouseY, scope) : undefined;
        if (candidate === null) { this.cancel(); return; }
        const identity = invocationIdentity(overrides);
        const previous = this.pending;
        if (candidate && previous?.candidate && previous.scope === scope && previous.continuous === continuous && previous.delayMs === delayMs
            && previous.invocationIdentity === identity && isSameHoverTranslationCandidate(previous.candidate, candidate)) {
            previous.mouseX = mouseX;
            previous.mouseY = mouseY;
            return;
        }
        this.cancel();
        const snapshot = this.ports.captureConfig(overrides);
        if (!this.ports.checkConfig(snapshot)) return;
        const pending: PendingHoverTranslation = {candidate, mouseX, mouseY, scope, continuous, delayMs, invocationIdentity: identity,
            timer: setTimeout(() => {
                if (this.pending !== pending) return;
                const current = this.ports.resolveCandidate(pending.mouseX, pending.mouseY, scope);
                if (this.pending !== pending) return;
                this.pending = undefined;
                if (!current || candidate && !isSameHoverTranslationCandidate(candidate, current)) return;
                this.ports.translate(current, snapshot, continuous);
            }, delayMs)};
        this.pending = pending;
    }
}

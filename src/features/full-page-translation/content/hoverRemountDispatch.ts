/**
 * @file src/features/full-page-translation/content/hoverRemountDispatch.ts
 * 文件职责：协调一次悬浮翻译请求的受限重挂观察和单次安全重试。
 * 主要内容：关联候选、冻结配置及手势，按提交代次和当前命中复核替换节点，处理取消、绘制等待与异常诊断。
 * 模块边界：通过端口获取配置、DOM 命中与翻译请求；不读取全局配置、不创建站点观察器、不复用旧译文。
 */
import type {TranslationCandidate, TranslationScope} from '@/src/core/translation/public';
import type {FullPageTranslationConfigSnapshot, PageTranslationConfigOverrides} from './translationConfigSnapshot';
import {trackXHoverRemount, type HoverRemountRecovery} from './hoverRemountRecovery';
import {HoverTranslationScheduler} from './hoverScheduler';

interface HoverRemountDispatchPorts {
    isAvailable(): boolean;
    isFullPageActive(): boolean;
    captureCommitGuard(): () => boolean;
    currentScope(): TranslationScope;
    captureConfig(overrides: PageTranslationConfigOverrides): FullPageTranslationConfigSnapshot;
    identity(snapshot: FullPageTranslationConfigSnapshot): string;
    checkConfig(snapshot: FullPageTranslationConfigSnapshot): boolean;
    noteGesture(): void;
    track?(candidate: TranslationCandidate, x: number, y: number, current: () => boolean,
        onCancel: () => void): HoverRemountRecovery | null;
    translate(candidate: TranslationCandidate, snapshot: FullPageTranslationConfigSnapshot, continuous: boolean):
        Promise<{status: string; detachedHoverAttempt?: boolean}>;
    resolve(x: number, y: number, scope?: TranslationScope): TranslationCandidate | null;
    hasState(candidate: TranslationCandidate): boolean;
    waitForPaint?(): Promise<void>;
    warn(error: unknown): void;
}

/** 同时最多观察四次手势；任何取消与身份不一致都只放弃恢复，不影响普通翻译。 */
export function createHoverRemountDispatch(ports: HoverRemountDispatchPorts) {
    const tracked = new Map<HTMLElement, HoverRemountRecovery>();
    const cancelOwner = (owner: HTMLElement) => {for (const recovery of tracked.values()) if (recovery.ownsOwner(owner)) recovery.cancel();};
    const cancelAll = () => {for (const recovery of tracked.values()) recovery.cancel(); tracked.clear();};
    const dispatch = (candidate: TranslationCandidate, snapshot: FullPageTranslationConfigSnapshot, continuous: boolean,
        x: number, y: number, scope: TranslationScope, overrides: PageTranslationConfigOverrides,
        inputSource?: 'mouse-shortcut', canCommit?: () => boolean) => {
        const current = () => {
            if (!ports.isAvailable() || ports.isFullPageActive() || ports.currentScope() !== scope || canCommit?.() === false) return false;
            const live = ports.captureConfig(overrides);
            return snapshot.useCache === live.useCache && ports.identity(snapshot) === ports.identity(live);
        };
        cancelOwner(candidate.element);
        let recovery: HoverRemountRecovery | null = null;
        if (inputSource === 'mouse-shortcut' && !continuous && !snapshot.profileId && Object.keys(overrides).length === 0 &&
            tracked.size < 4 && !ports.isFullPageActive() && ports.currentScope() === scope && canCommit?.() !== false) {
            const onCancel = () => {
                if (tracked.get(candidate.element) === recovery) tracked.delete(candidate.element);
            };
            recovery = ports.track ? ports.track(candidate, x, y, current, onCancel)
                : trackXHoverRemount(candidate, x, y, current, onCancel);
            if (recovery) tracked.set(candidate.element, recovery);
        }
        void ports.translate(candidate, snapshot, continuous).then(async outcome => {
            if (recovery && outcome.status === 'stale' && outcome.detachedHoverAttempt) {
                if (!await recovery.waitForReplacement()) return;
                await (ports.waitForPaint?.() ?? new Promise<void>(resolve => {
                    const timer = window.setTimeout(() => {cancelAnimationFrame(frame); resolve();}, 100);
                    const frame = requestAnimationFrame(() => {clearTimeout(timer); resolve();});
                }));
            }
            if (!recovery || tracked.get(candidate.element) !== recovery) {recovery?.cancel(); return;}
            tracked.delete(candidate.element);
            const replacement = recovery.finish(outcome.status === 'stale' && outcome.detachedHoverAttempt === true);
            if (!replacement || !current()) return;
            const resolved = ports.resolve(x, y, candidate.scope);
            const hasState = resolved && ports.hasState(resolved);
            if (!resolved || resolved.element !== replacement.element || resolved.kind !== candidate.kind ||
                resolved.scope !== candidate.scope || resolved.reason !== candidate.reason || resolved.adapterId !== candidate.adapterId ||
                resolved.nodes?.length || resolved.visualRange || resolved.manualChunk || resolved.sourceLine !== candidate.sourceLine ||
                resolved.allowTopLevelApplicationShell !== candidate.allowTopLevelApplicationShell ||
                resolved.applicationShellPolicyId !== candidate.applicationShellPolicyId || hasState) return;
            await ports.translate(resolved, snapshot, false);
        }).catch(error => {recovery?.cancel(); ports.warn(error);});
    };
    const scheduler = new HoverTranslationScheduler({
        isAvailable: ports.isAvailable, captureCommitGuard: ports.captureCommitGuard,
        currentScope: ports.currentScope, resolveCandidate: ports.resolve, captureConfig: ports.captureConfig,
        checkConfig: ports.checkConfig, noteGesture: ports.noteGesture,
        translate: ports.translate,
        cancelTracked: cancelAll, dispatchTracked: dispatch,
    });
    return {scheduler, cancelOwner};
}

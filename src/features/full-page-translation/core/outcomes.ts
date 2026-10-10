/**
 * @file src/features/full-page-translation/core/outcomes.ts
 * 文件职责：按当前全文会话拥有的目标维护完成、失败和正在处理计数，避免每次刷新进度遍历整页译文。
 * 主要内容：以目标身份增量更新阶段、移除旧目标、登记失败恢复动作，并只遍历失败集合执行显式重试或定位。
 * 模块边界：不访问 DOM、请求服务或保存原文；运行时负责目标资格与代次检查，调用方在会话结束时清空引用。
 */
export type FullPageOutcomePhase = 'loading' | 'translated' | 'error';

export function createFullPageOutcomeRegistry<T>() {
    const phases = new Map<T, FullPageOutcomePhase>();
    const retries = new Map<T, () => boolean>();
    const counts = {loading: 0, completed: 0, failed: 0};
    const field = (phase: FullPageOutcomePhase) => phase === 'translated' ? 'completed' : phase === 'error' ? 'failed' : 'loading';
    return {
        has(target: T): boolean { return phases.has(target); },
        update(target: T, phase?: FullPageOutcomePhase): void {
            const previous = phases.get(target);
            if (previous === phase) return;
            if (previous) counts[field(previous)] -= 1;
            if (phase) {phases.set(target, phase); counts[field(phase)] += 1;}
            else phases.delete(target);
            if (phase !== 'error') retries.delete(target);
        },
        setRetry(target: T, retry: () => boolean): void {
            if (phases.get(target) === 'error') retries.set(target, retry);
        },
        snapshot(): typeof counts { return {...counts}; },
        retry(eligible: (target: T) => boolean): number {
            let started = 0;
            // 重试回调会同步切换阶段；快照仅包含失败，成功译文不参与遍历和重译。
            for (const [target, callback] of [...retries]) {
                if (retries.get(target) === callback && eligible(target) && callback()) started += 1;
            }
            return started;
        },
        firstFailure(eligible: (target: T) => boolean): T | undefined {
            for (const target of retries.keys()) if (eligible(target)) return target;
            return undefined;
        },
        countFailures(eligible: (target: T) => boolean): number {
            let count = 0;
            for (const target of retries.keys()) if (eligible(target)) count += 1;
            return count;
        },
        clear(): void {
            phases.clear(); retries.clear(); counts.loading = 0; counts.completed = 0; counts.failed = 0;
        },
    };
}

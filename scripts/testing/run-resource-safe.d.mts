export interface ResourceOptions {
    command: string;
    args: string[];
    cpuTargetPercent: number;
    maxWorkers: number;
    waitMs: number;
    /** 全局测试锁的并发槽位数，1 为完全串行。 */
    concurrency: number;
}

export const DEFAULT_CPU_TARGET_PERCENT: number;
export const DEFAULT_MAX_WORKERS: number;
export const DEFAULT_LOCK_WAIT_MS: number;
export const DEFAULT_CONCURRENCY: number;
export function parseArgs(argv: string[]): ResourceOptions | {help: true};
export function createResourceOptions(command: string, args?: string[]): ResourceOptions;
export function acquireLock(options: ResourceOptions): Promise<void>;
export function releaseLock(): Promise<void>;
export function hasInheritedLock(): Promise<boolean>;
export function runResourceSafe(argv?: string[]): Promise<number>;

import type {UserscriptSizeBudget, UserscriptSizeEvaluation} from './testing/userscript-size-budget.mjs';

export interface UserscriptBaselineUpdateResult {
    bytes: number;
    status: 'ok';
    updated: UserscriptSizeBudget;
}

export function verifyUserscriptStandaloneBuild(
    argv?: string[],
): UserscriptSizeEvaluation | UserscriptBaselineUpdateResult;

export const DEFAULT_USERSCRIPT_SIZE_BUDGET_PATH: string;

export interface UserscriptSizeBudget {
    baselineBytes: number;
    softWarnDeltaBytes: number;
    hardMaxDeltaBytes: number;
    updatedFromCommit?: string;
    notes?: string;
}

export type UserscriptSizeStatus = 'ok' | 'warn' | 'fail';

export interface UserscriptSizeEvaluation {
    status: UserscriptSizeStatus;
    bytes: number;
    baselineBytes: number;
    deltaBytes: number;
    softWarnBytes: number;
    hardMaxBytes: number;
    message: string;
}

export interface UpdateUserscriptSizeBudgetMetadata {
    updatedFromCommit?: string;
    notes?: string;
}

export function validateUserscriptSizeBudget(budget: unknown): UserscriptSizeBudget;
export function loadUserscriptSizeBudget(budgetPath?: string): UserscriptSizeBudget;
export function evaluateUserscriptStandaloneSize(bytes: number, budget: UserscriptSizeBudget): UserscriptSizeEvaluation;
export function updateUserscriptSizeBudget(
    budgetPath: string,
    newBaselineBytes: number,
    metadata?: UpdateUserscriptSizeBudgetMetadata,
): UserscriptSizeBudget;

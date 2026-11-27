import type {DependencyEdgeVia, DependencyExplanation, DependencyGraphAnalysis} from './dependency-graph.mjs';

export type {DependencyEdgeVia, DependencyExplanation, DependencyGraphAnalysis};

export interface TestMatrix {
    groups: Partial<Record<'architecture' | 'unit' | 'functional' | 'regression', string[]>>;
}
export const CODE: RegExp;
export const DEPENDENCY_CONTENT: RegExp;
export const REPO_WIDE_ARCHITECTURE_GATE: RegExp;
export function packageJsonRuntimeSignature(source: string): string;
export function analyzeDependencyGraph(files: Record<string, string>): DependencyGraphAnalysis;
export function collectAffectedClosure(reverse: Map<string, Set<string>>, seeds: Iterable<string>): Set<string>;
export function explainDependencies(owner: string, source: string, known: Set<string>, files?: Record<string, string> | null): DependencyExplanation[];
export interface AffectedPlan {
    changed: string[];
    testFiles: string[];
    alwaysRunArchitecture: string[];
    affectedScopedTests: string[];
    coverageFiles: string[];
    globalInputs: string[];
    reason: 'shared-test-configuration' | 'changed-dependency-graph';
    extensionChanged: boolean;
    base?: string;
    head?: string;
}
export function changedPaths(root: string, base: string): {base: string; paths: string[]};
export function strictCoveragePaths(source: string): string[];
export function coverageRuntimeSignature(source: string, configPath?: string): string;
export function buildDependencyGraph(files: Record<string, string>): Map<string, Set<string>>;
export function selectAffected(input: {
    files: Record<string, string>;
    changed: string[];
    matrix: TestMatrix;
    coveragePaths: string[];
    coverageAdded?: string[];
    coverageRuntimeChanged?: boolean;
    inertGlobalInputs?: string[];
    allArchitecture?: boolean;
}): AffectedPlan;
export function loadWorkspaceFiles(root: string, extraPaths?: string[]): Record<string, string>;
export function createPlan(root: string, base: string, options?: {explicitFiles?: string[] | null; allArchitecture?: boolean}): AffectedPlan;
export function scopedCoverageConfig(plan: AffectedPlan, baseConfigUrl: string): string;
export function testInvocation(plan: Pick<AffectedPlan, 'testFiles' | 'coverageFiles'>, configPath: string, options?: {reporter?: string | null}): string[] | null;
export function executePlan(
    root: string,
    plan: AffectedPlan,
    runner?: (root: string, args: string[]) => Promise<{code: number | null; signal: string | null}>,
    options?: {reporter?: string | null},
): Promise<{skipped: boolean; reason?: string}>;
export function renderSummary(plan: AffectedPlan): string;
export function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<void>;

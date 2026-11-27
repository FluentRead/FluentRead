export const CODE: RegExp;
export const DEPENDENCY_CONTENT: RegExp;
export const TEST_FILE_PATTERN: RegExp;
export const REGISTRY_DATA_FILES: Set<string>;

export type DependencyEdgeVia =
    | 'import'
    | 'barrel-symbol'
    | 'dynamic-import'
    | 'vi-mock'
    | 'file-read'
    | 'template'
    | 'directory'
    | 'css-import'
    | 'vue-asset';

export interface DependencyExplanation {
    reference: string;
    via: DependencyEdgeVia;
    files: string[];
}

export interface DependencyGraphAnalysis {
    graph: Map<string, Set<string>>;
    reverse: Map<string, Set<string>>;
    barrels: Set<string>;
    infoMap: Map<string, unknown>;
    known: Set<string>;
}

export function projectPath(owner: string, value: string): string | null;
export function resolveExactModule(known: Set<string>, owner: string, specifier: string): string | null;
export function analyzeDependencyGraph(files: Record<string, string>): DependencyGraphAnalysis;
export function buildDependencyGraph(files: Record<string, string>): Map<string, Set<string>>;
export function collectAffectedClosure(reverse: Map<string, Set<string>>, seeds: Iterable<string>): Set<string>;
export function explainDependencies(
    owner: string,
    source: string,
    known: Set<string>,
    files?: Record<string, string> | null,
): DependencyExplanation[];

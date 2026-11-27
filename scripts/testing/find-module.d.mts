export const DEFAULT_MODULE_INDEX_CACHE_PATH: string;
export const MODULE_INDEX_CACHE_VERSION: string;

export interface FindModuleOptions {
    queries: string[];
    dir: string | null;
    limit: number;
    includeScripts: boolean;
    json: boolean;
    noCache: boolean;
    help: boolean;
}

export interface ModuleIndexEntry {
    path: string;
    fileTag: string | null;
    responsibility: string;
    contents: string;
    boundary: string;
    hasHeader: boolean;
}

export interface ModuleIndexCacheStats {
    hits: number;
    misses: number;
    evicted: number;
    total: number;
    fromCache: boolean;
    cachePath: string;
}

export interface ModuleIndexLoadResult {
    entries: ModuleIndexEntry[];
    cacheStats: ModuleIndexCacheStats;
}

export interface ModuleSearchHit {
    path: string;
    score: number;
    matchedTokens: number;
    responsibility: string;
    contents: string;
    boundary: string;
}

export interface ModuleSearchResult {
    totalIndexed: number;
    totalMatched: number;
    results: ModuleSearchHit[];
}

export function parseArguments(argv: string[]): FindModuleOptions;
export function parseHeader(filePath: string, source: string): ModuleIndexEntry;
export function loadModuleIndex(
    projectRoot: string,
    options?: {roots?: string[]; includeScripts?: boolean; cachePath?: string; noCache?: boolean},
): ModuleIndexLoadResult;
export function tokenizeQuery(queries: string | string[]): string[];
export function searchModules(
    entries: ModuleIndexEntry[],
    queries: string | string[],
    options?: {dir?: string | null; limit?: number},
): ModuleSearchResult;
export function formatResults(queryLabel: string, searchResult: ModuleSearchResult): string;
export function main(argv?: string[]): void;

export const DEFAULT_GROUP: 'unit';
export const ALLOWED_GROUPS: readonly ['unit', 'functional', 'regression'];

export type DefaultTestGroup = 'unit' | 'functional' | 'regression';

export interface SyncRegistriesOptions {
    write: boolean;
    group: DefaultTestGroup;
    root: string;
    json: boolean;
    help: boolean;
}

export interface SourceModuleClassification {
    typeOnly: boolean;
    pureBarrel: boolean;
    declarativeVue: boolean;
}

export interface RegistrySyncReport {
    hasDrift: boolean;
    matrix: {
        missing: Array<{file: string; group: string}>;
        stale: Array<{file: string; group: string}>;
        duplicates: Array<{file: string; firstGroup: string; duplicateGroup: string}>;
    };
    coverage: {
        missing: string[];
        stale: string[];
        duplicates: string[];
        allowlistCount: number;
    };
    written?: string[];
}

export function parseArguments(argv: string[]): SyncRegistriesOptions;
export function readBuildOnlyAllowlist(ownershipTestSource: string): Set<string>;
export function classifySourceModule(filePath: string, source: string): SourceModuleClassification;
export function analyzeRegistries(projectRoot: string, options?: {group?: DefaultTestGroup}): RegistrySyncReport;
export function applyMatrixSync(matrixSource: string, report: RegistrySyncReport): string;
export function applyCoverageConfigSync(configSource: string, report: RegistrySyncReport): string;
export function syncRegistries(
    projectRoot: string,
    options?: {write?: boolean; group?: DefaultTestGroup},
): RegistrySyncReport & {written: string[]};
export function formatReport(result: RegistrySyncReport, options?: {write?: boolean}): string;
export function main(argv?: string[]): void;

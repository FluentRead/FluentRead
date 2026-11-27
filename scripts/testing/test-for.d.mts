export interface TestForOptions {
    targets: string[];
    dryRun: boolean;
    coverage: boolean;
    includeArch: boolean;
    noCache: boolean;
    reporter: string;
    testNamePattern: string | null;
    json: boolean;
    help: boolean;
}

export interface TestForPlan {
    targets: string[];
    testFiles: string[];
    coverageFiles: string[];
}

export function parseArguments(argv: string[]): TestForOptions;
export function planTestsForPaths(root: string, rawTargets: string[], options?: Partial<TestForOptions>): TestForPlan;
export function main(argv?: string[]): Promise<void>;

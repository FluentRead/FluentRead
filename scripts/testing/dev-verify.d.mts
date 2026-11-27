export interface DevVerifyOptions {
    base: string;
    files: string | null;
    compile: boolean;
    allArchitecture: boolean;
    dryRun: boolean;
    failFast: boolean;
    continueOnError: boolean;
    artifactsDir: string | null;
    json: boolean;
    help: boolean;
}

export interface DevVerifyStep {
    id: string;
    label: string;
    command: string;
    args: string[];
}

export function parseArguments(argv: string[]): DevVerifyOptions;
export function buildSteps(options: DevVerifyOptions, artifactsDir: string): DevVerifyStep[];
export function failureExcerpt(tail: string, maxLines?: number): string[];
export function main(argv?: string[]): Promise<void>;

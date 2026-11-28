export interface CheckStagedFastOptions {
    files: string[] | null;
    root: string;
    json: boolean;
    help: boolean;
}

export interface CheckStagedFastResult {
    status: 'passed' | 'failed';
    checked: number;
    durationMs: number;
    errors: string[];
    warnings: string[];
}

export function parseArguments(argv: string[]): CheckStagedFastOptions;
export function getStagedFiles(root: string): string[];
export function checkSourceHeader(filePath: string, source: string): string[];
export function checkTestFile(filePath: string, source: string, registeredTests?: Set<string> | null): string[];
export function checkRawHexColors(filePath: string, source: string): string[];
export function checkFiles(root: string, files: string[]): CheckStagedFastResult;
export function formatReport(result: CheckStagedFastResult): string;
export function main(argv?: string[]): void;

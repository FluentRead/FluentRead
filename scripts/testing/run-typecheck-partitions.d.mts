export interface TypecheckManifest {
    fingerprint: string;
    manifest: {roots: readonly string[]; files: readonly unknown[]; [key: string]: unknown};
}
export interface TypecheckReceipt {
    fingerprint: string;
    complete: boolean;
    selected: readonly number[];
}
export interface VerifiedTypecheck {
    fingerprint: string;
    sourceFiles: number;
    roots: number;
    partitions: number;
}
export function verifyTypecheckReceipts(manifests: readonly TypecheckManifest[], results: readonly TypecheckReceipt[]): VerifiedTypecheck;
export function runTypecheck(project?: string): Promise<VerifiedTypecheck>;

export interface DeclarationComparison {
    missing: string[];
    extra: string[];
}

export interface DeclarationAuditRow extends DeclarationComparison {
    declaration: string;
    implementation: string;
}

export function findDeclarations(root: string): string[];
export function exportedNames(source: string, filename: string): Map<string, 'value' | 'type'>;
export function comparePair(implementationSource: string, declarationSource: string, filename: string): DeclarationComparison;
export function analyze(root: string): DeclarationAuditRow[];
export function formatText(rows: DeclarationAuditRow[]): string;

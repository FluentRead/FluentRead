export type SupportedMessageLocale = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR' | 'fr-FR' | 'ru-RU' | 'es-ES';

export const SUPPORTED_LOCALES: readonly SupportedMessageLocale[];

export interface ScaffoldFeatureMessagesOptions {
    featureName: string;
    title?: string;
    keys?: string | readonly string[];
    dir?: string;
    root?: string;
    dryRun?: boolean;
    force?: boolean;
}

export interface PlannedFeatureMessageFile {
    path: string;
    kind: 'locale-json' | 'wrapper-ts';
    locale: SupportedMessageLocale | null;
    content: string;
}

export interface FeatureMessagePlan {
    featureName: string;
    camelCaseName: string;
    title: string;
    baseDir: string;
    localeDir: string;
    wrapperPath: string;
    keys: string[];
    files: PlannedFeatureMessageFile[];
}

export interface ScaffoldFeatureMessagesResult extends FeatureMessagePlan {
    dryRun: boolean;
    force: boolean;
    written: string[];
    conflicts: string[];
}

export interface ScaffoldCliOptions {
    featureName: string;
    title: string | undefined;
    keys: string | undefined;
    dir: string;
    dryRun: boolean;
    force: boolean;
    help: boolean;
}

export function validateFeatureName(name: string): string;
export function kebabToCamelCase(name: string): string;
export function buildFeatureMessagePlan(options: Omit<ScaffoldFeatureMessagesOptions, 'dryRun' | 'force'>): FeatureMessagePlan;
export function scaffoldFeatureMessages(options: ScaffoldFeatureMessagesOptions): ScaffoldFeatureMessagesResult;
export function parseArguments(argv: string[]): ScaffoldCliOptions;
export function main(argv?: string[]): Promise<void>;

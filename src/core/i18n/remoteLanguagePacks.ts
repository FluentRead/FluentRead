/**
 * @file src/core/i18n/remoteLanguagePacks.ts
 * 文件职责：声明五种非默认界面语言的固定远程基线资产元数据，以及基线与局部增量的纯函数生成与合并规则。
 * 主要内容：固定已提交的五种语言基线路径、精确字节长度与 SHA-256，提供 delta-v1 增量包格式识别、构建期增量计算与运行时无损合并，确保还原后的资源包与完整词典逐项等价。
 * 模块边界：本文件属于 core 纯数据与纯算法层，不导入任何外部语言 JSON 文件、不发起网络请求、不访问存储或 DOM。
 */

import {buildGithubAssetMirrorUrls} from '../assets/mirrors';
import type {LegacyPatternEntry, MessageCatalog, RegisteredUiLanguage, UiLanguageBundle} from './types';

export type RemoteDeltaUiLanguage = Exclude<RegisteredUiLanguage, 'en-US'>;

export interface RemoteLanguageBaseAsset {
    readonly language: RemoteDeltaUiLanguage;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface DeltaUiLanguageBundle {
    readonly format: 'delta-v1';
    readonly language: RemoteDeltaUiLanguage;
    readonly baseRevision: string;
    readonly basePath: string;
    readonly baseBytes: number;
    readonly baseSha256: string;
    readonly messages: MessageCatalog;
    readonly legacyText: MessageCatalog;
    readonly removedMessages?: readonly string[];
    readonly removedLegacyText?: readonly string[];
    readonly legacyPatterns: {
        readonly early: readonly LegacyPatternEntry[];
        readonly late: readonly LegacyPatternEntry[];
    };
    readonly patternOrder?: Partial<Record<'early' | 'late', readonly number[]>>;
}

export const EXTENSION_I18N_BASE_REPOSITORY = 'FluentRead/FluentRead';
export const EXTENSION_I18N_BASE_REVISION = '3a8a32e3e2b8a213ea02452f881b9064e6d9d816';
export const EXTENSION_I18N_BASE_CACHE = 'fluentread-i18n-base-v1';

export const REMOTE_LANGUAGE_BASE_ASSETS: Readonly<Record<RemoteDeltaUiLanguage, RemoteLanguageBaseAsset>> = {
    'ja-JP': {
        language: 'ja-JP',
        path: 'userscript/languages/ja-JP.b81984c57e32c317.json',
        bytes: 567_982,
        sha256: 'ab81c3b90750742688f5c91d34aa77652008f45ccc4161828845b655f9149c01',
    },
    'ko-KR': {
        language: 'ko-KR',
        path: 'userscript/languages/ko-KR.f9dd4e317a3ccbac.json',
        bytes: 536_854,
        sha256: '381db6c6544fe74c0c1952b4d9f1e9873ce1879ce05e9e0266e19f98db5f68ea',
    },
    'fr-FR': {
        language: 'fr-FR',
        path: 'userscript/languages/fr-FR.fcc79905550b3705.json',
        bytes: 537_356,
        sha256: '640eff3c0704105411dd30ca53312a9c883c36c0f100b7b27898fe0e79d3b86d',
    },
    'ru-RU': {
        language: 'ru-RU',
        path: 'userscript/languages/ru-RU.83347fe7c1e5f5da.json',
        bytes: 703_413,
        sha256: 'cc7b800185ced353b90bbe898010b12202ae282e74d2ffcad832ab94de8e8dc6',
    },
    'es-ES': {
        language: 'es-ES',
        path: 'userscript/languages/es-ES.ccf366fbe218633c.json',
        bytes: 522_931,
        sha256: '906fcc16e553412e29e2f8b5c1aa6f777e24a27b1dd31d290ba7dc026840d5ae',
    },
};

export function isRemoteDeltaUiLanguage(language: string): language is RemoteDeltaUiLanguage {
    return Object.hasOwn(REMOTE_LANGUAGE_BASE_ASSETS, language);
}

/** 构造固定版本远程语言基线的国内外四路镜像地址。 */
export function getRemoteLanguageBaseUrls(
    asset: Pick<DeltaUiLanguageBundle, 'baseRevision' | 'basePath'>,
    locale?: string,
): readonly string[] {
    return buildGithubAssetMirrorUrls(EXTENSION_I18N_BASE_REPOSITORY, asset.baseRevision, asset.basePath, locale);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyPatternList(value: unknown): value is readonly LegacyPatternEntry[] {
    return Array.isArray(value) && value.every((entry) => Array.isArray(entry)
        && typeof entry[0] === 'string'
        && typeof entry[1] === 'string'
        && (entry[2] === undefined || (Array.isArray(entry[2]) && entry[2].every(Number.isSafeInteger))));
}

function isPatternOrderPhase(value: unknown): boolean {
    return value === undefined || (Array.isArray(value) && value.every(Number.isSafeInteger));
}

export function isDeltaUiLanguageBundle(value: unknown): value is DeltaUiLanguageBundle {
    if (!isPlainRecord(value)) return false;
    if (value.format !== 'delta-v1' || typeof value.language !== 'string' || !isRemoteDeltaUiLanguage(value.language)) return false;
    if (typeof value.baseRevision !== 'string' || typeof value.basePath !== 'string') return false;
    if (!Number.isSafeInteger(value.baseBytes) || (value.baseBytes as number) <= 0) return false;
    if (typeof value.baseSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.baseSha256)) return false;
    if (!isPlainRecord(value.messages) || !isPlainRecord(value.legacyText)) return false;
    if (!Object.values(value.messages).every(item => typeof item === 'string')) return false;
    if (!Object.values(value.legacyText).every(item => typeof item === 'string')) return false;
    if (value.removedMessages !== undefined && (!Array.isArray(value.removedMessages) || !value.removedMessages.every(item => typeof item === 'string'))) return false;
    if (value.removedLegacyText !== undefined && (!Array.isArray(value.removedLegacyText) || !value.removedLegacyText.every(item => typeof item === 'string'))) return false;
    if (!isPlainRecord(value.legacyPatterns)) return false;
    if (!isLegacyPatternList(value.legacyPatterns.early) || !isLegacyPatternList(value.legacyPatterns.late)) return false;
    if (value.patternOrder !== undefined) {
        if (!isPlainRecord(value.patternOrder)) return false;
        if (!isPatternOrderPhase(value.patternOrder.early) || !isPatternOrderPhase(value.patternOrder.late)) return false;
    }
    return true;
}

/** 比较完整语言包与固定基线，生成最小可复现增量包（保留正则顺序与新增/变更项）。 */
export function createDeltaUiLanguageBundle(
    language: RemoteDeltaUiLanguage,
    full: UiLanguageBundle,
    baseline: UiLanguageBundle,
): DeltaUiLanguageBundle {
    const asset = REMOTE_LANGUAGE_BASE_ASSETS[language];
    const diffCatalog = (current: MessageCatalog, previous: MessageCatalog): MessageCatalog =>
        Object.fromEntries(
            Object.entries(current)
                .filter(([key, value]) => !Object.hasOwn(previous, key) || previous[key] !== value)
                .sort(([left], [right]) => (left < right ? -1 : 1)),
        );

    const legacyPatterns: {early: LegacyPatternEntry[]; late: LegacyPatternEntry[]} = {early: [], late: []};
    const patternOrder: Partial<Record<'early' | 'late', number[]>> = {};
    for (const phase of ['early', 'late'] as const) {
        if (JSON.stringify(full.legacyPatterns[phase]) === JSON.stringify(baseline.legacyPatterns[phase])) continue;
        const previousIndex = new Map(baseline.legacyPatterns[phase].map((entry, index) => [JSON.stringify(entry), index]));
        const additions: LegacyPatternEntry[] = [];
        patternOrder[phase] = full.legacyPatterns[phase].map((entry) => {
            const existing = previousIndex.get(JSON.stringify(entry));
            if (existing !== undefined) return existing;
            additions.push(entry);
            return -additions.length;
        });
        legacyPatterns[phase] = additions;
    }

    const removedKeys = (current: MessageCatalog, previous: MessageCatalog): string[] =>
        Object.keys(previous).filter(key => !Object.hasOwn(current, key)).sort();

    const removedMessages = removedKeys(full.messages, baseline.messages);
    const removedLegacyText = removedKeys(full.legacyText, baseline.legacyText);

    return {
        format: 'delta-v1',
        language,
        baseRevision: EXTENSION_I18N_BASE_REVISION,
        basePath: asset.path,
        baseBytes: asset.bytes,
        baseSha256: asset.sha256,
        messages: diffCatalog(full.messages, baseline.messages),
        legacyText: diffCatalog(full.legacyText, baseline.legacyText),
        ...(removedMessages.length ? {removedMessages} : {}),
        ...(removedLegacyText.length ? {removedLegacyText} : {}),
        legacyPatterns,
        ...(Object.keys(patternOrder).length ? {patternOrder} : {}),
    };
}

/** 将固定远程基线与扩展增量包无损合并为完整 UiLanguageBundle。 */
export function mergeDeltaUiLanguageBundle(
    baseline: UiLanguageBundle,
    delta: DeltaUiLanguageBundle,
): UiLanguageBundle {
    const mergePhase = (phase: 'early' | 'late'): readonly LegacyPatternEntry[] => {
        const order = delta.patternOrder?.[phase];
        if (!order) {
            return delta.legacyPatterns[phase].length > 0
                ? [...baseline.legacyPatterns[phase], ...delta.legacyPatterns[phase]]
                : baseline.legacyPatterns[phase];
        }
        return order.map((index) => {
            const entry = index >= 0 ? baseline.legacyPatterns[phase][index] : delta.legacyPatterns[phase][-index - 1];
            if (!entry) throw new RangeError(`Invalid pattern order index ${index} in ${delta.language}.${phase}`);
            return entry;
        });
    };

    const messages: Record<string, string> = {...baseline.messages, ...delta.messages};
    if (delta.removedMessages) {
        for (const key of delta.removedMessages) delete messages[key];
    }
    const legacyText: Record<string, string> = {...baseline.legacyText, ...delta.legacyText};
    if (delta.removedLegacyText) {
        for (const key of delta.removedLegacyText) delete legacyText[key];
    }

    return {
        messages,
        legacyText,
        legacyPatterns: {
            early: mergePhase('early'),
            late: mergePhase('late'),
        },
    };
}

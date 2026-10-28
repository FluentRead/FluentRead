/**
 * @file userscript/languageData.ts
 * 文件职责：无损编码脚本本地内嵌的中英文语言数据，让新增多语文案继续满足既有单文件预算。
 * 主要内容：目录按键和值分列，模板按正则、译文和可选捕获组分列；standalone 英文仅在键列与默认中文完全同序时省略该列。解码验证列长与字符串类型，恢复字典和模板次序，保留合法旧完整列及对象格式。
 * 模块边界：只转换静态数据表示，不执行模板、不加载完整词典、不压缩可执行逻辑。
 */
import type {LegacyPatternEntry, MessageCatalog, UiLanguageBundle} from '@/src/core/i18n/types';
import {USERSCRIPT_DATA_ALPHABET} from './dataEncoding';

export type KeyColumn = readonly string[] | {readonly p: readonly string[]};
export type CatalogColumns = readonly [readonly string[], readonly string[]];
export type PackedCatalogColumns = readonly [KeyColumn, readonly string[]];
type PatternColumns = readonly [readonly string[], readonly string[], readonly (readonly number[] | null)[]];
type LanguageColumns = readonly [keys: readonly [readonly string[] | null, KeyColumn], early: PatternColumns, late: PatternColumns, texts: readonly [readonly string[], KeyColumn]];

/** 构建期稳定排序；中英同序目录可共用已经内嵌的中文键列。 */
export function packMessageCatalog(value: MessageCatalog): CatalogColumns {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1);
    return [entries.map(([key]) => key), entries.map(([, text]) => text)];
}

/** 使用前一个键的最长公共前缀压缩；按 UTF-16 单元处理，截断也能精确还原。 */
export function packKeyColumn(keys: readonly string[]): KeyColumn {
    let previous = '';
    return {p: keys.map(key => {
        let prefix = 0;
        while (prefix < 84 && prefix < previous.length && prefix < key.length && previous[prefix] === key[prefix]) prefix++;
        previous = key;
        return USERSCRIPT_DATA_ALPHABET[prefix]! + key.slice(prefix);
    })};
}

/** 旧数组直接保留；前缀列严格验证，以防损坏数据影响共享键。 */
export function unpackKeyColumn(value: unknown): string[] {
    if (Array.isArray(value)) {
        if (!Array.from(value).every(item => typeof item === 'string')) throw new TypeError('Invalid UI message keys');
        return [...value];
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
        || !Object.hasOwn(value, 'p') || !Array.isArray((value as {p: unknown}).p)) throw new TypeError('Invalid UI message keys');
    let previous = '';
    return Array.from((value as {p: unknown[]}).p, item => {
        if (typeof item !== 'string' || !item.length) throw new TypeError('Invalid UI message keys');
        const length = USERSCRIPT_DATA_ALPHABET.indexOf(item[0]!);
        if (length < 0 || length > previous.length) throw new TypeError('Invalid UI message keys');
        previous = previous.slice(0,length) + item.slice(1);
        return previous;
    });
}

/** 验证后按原列次序恢复；重复键和特殊键沿用 Object.fromEntries 的行为。 */
export function unpackMessageCatalog(value: unknown): MessageCatalog {
    if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1])
        || !Array.from(value[1]).every(item => typeof item === 'string')) throw new TypeError('Invalid UI message columns');
    const keys = unpackKeyColumn(value[0]);
    if (keys.length !== value[1].length) throw new TypeError('Invalid UI message columns');
    return Object.fromEntries(keys.map((key, index) => [key, value[1][index]]));
}

/** 只供构建使用；按键排序使输出不受导入和对象展开次序影响。 */
export function packUiLanguageBundle(bundle: UiLanguageBundle, sharedMessageKeys?: readonly string[], prefixLegacy = false): LanguageColumns {
    const patterns = (entries: readonly LegacyPatternEntry[]): PatternColumns => [
        entries.map(([source]) => source), entries.map(([, text]) => text), entries.map(([, , captures]) => captures ?? null),
    ];
    const messages = packMessageCatalog(bundle.messages), legacy = packMessageCatalog(bundle.legacyText);
    const shared = sharedMessageKeys?.length === messages[0].length && messages[0].every((key, index) => key === sharedMessageKeys[index]);
    // 资源键与模板相邻，完整译文集中在末尾，减少模板和目录中的相同片段超出 gzip 窗口。
    return [[shared ? null : messages[0], prefixLegacy ? packKeyColumn(legacy[0] as readonly string[]) : legacy[0]], patterns(bundle.legacyPatterns.early), patterns(bundle.legacyPatterns.late), [messages[1], prefixLegacy ? packKeyColumn(legacy[1]) : legacy[1]]];
}

/** 恢复并验证本地目录列；原始对象格式保持兼容，完整 bundle 形状继续由加载器统一校验。 */
export function unpackUiLanguageBundle(value: UiLanguageBundle | LanguageColumns, sharedMessageKeys?: readonly string[]): UiLanguageBundle {
    if (!Array.isArray(value)) return value as UiLanguageBundle;
    const patterns = ([sources, texts, captures]: PatternColumns): LegacyPatternEntry[] => sources.map((source, index) =>
        captures[index] === null ? [source, texts[index]] : [source, texts[index], captures[index]!]);
    return {messages: unpackMessageCatalog([value[0][0] === null ? sharedMessageKeys : value[0][0], value[3][0]]), legacyText: unpackMessageCatalog([value[0][1], unpackKeyColumn(value[3][1])]),
        legacyPatterns: {early: patterns(value[1]), late: patterns(value[2])}};
}

/** 合并各语言增量的键列；null 只表示缺失，空字符串仍是有效译文。 */
export function packLanguageUpdates(updates: Record<string, import('./languageBundles').UserscriptLanguageUpdate>): unknown {
    const entries = Object.keys(updates).sort().map(key=>[key,updates[key]!] as const);
    const keys = (field:'messages'|'legacyText') => [...new Set(entries.flatMap(([,update])=>Object.keys(update[field])))].sort();
    const messages = keys('messages'), legacy = keys('legacyText');
    const rows = Object.fromEntries(entries.map(([language,update])=>[language,
        [messages.map(key=>Object.hasOwn(update.messages,key)?update.messages[key]:null),
            legacy.map(key=>Object.hasOwn(update.legacyText,key)?update.legacyText[key]:null), update.legacyPatterns, update.patternOrder ?? null]]));
    return {format:'shared-columns-v1',messages,legacy,rows};
}

/** 支持旧对象；新格式在发布前完整校验，不丢失空字符串或模板顺序。 */
export function unpackLanguageUpdates(value: unknown): Record<string, import('./languageBundles').UserscriptLanguageUpdate> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid UI language updates');
    if (!Object.hasOwn(value,'format')) return value as Record<string, import('./languageBundles').UserscriptLanguageUpdate>;
    const packed=value as {format:unknown;messages:unknown;legacy:unknown;rows:unknown};
    if(packed.format!=='shared-columns-v1' || !Array.isArray(packed.messages) || !Array.isArray(packed.legacy)
        || !Array.from(packed.messages).every(key=>typeof key==='string') || !Array.from(packed.legacy).every(key=>typeof key==='string')
        || !packed.rows || typeof packed.rows!=='object' || Array.isArray(packed.rows)) throw new TypeError('Invalid UI language updates');
    const catalog=(keys:string[], values:unknown) => {
        if(!Array.isArray(values) || values.length!==keys.length || !Array.from(values).every(item=>item===null || typeof item==='string')) throw new TypeError('Invalid UI language updates');
        return Object.fromEntries(keys.flatMap((key,index)=>values[index]===null?[]:[[key,values[index]]]));
    };
    return Object.fromEntries(Object.entries(packed.rows).map(([language,row])=>{
        if(!Array.isArray(row) || row.length!==4) throw new TypeError('Invalid UI language updates');
        return [language,{messages:catalog(packed.messages as string[],row[0]),legacyText:catalog(packed.legacy as string[],row[1]),legacyPatterns:row[2],...(row[3]===null?{}:{patternOrder:row[3]})}];
    }));
}

/**
 * @file src/core/glossary/revisionMemo.ts
 * 文件职责：为重复读取的可变术语配置提供保真且有界的版本摘要复用，降低悬浮手势中反复规范化、序列化和散列整份词库的成本。
 * 主要内容：只缓存一份普通数据对象的原始标量镜像，逐次复核库、条目、域名及顺序；原地编辑、数组替换和库启停仍触发精确摘要重算，访问器、缺失字段、超限或非常规对象沿用原始算法。
 * 模块边界：只读取传入规则，不访问全局配置、注册订阅或缓存 DOM；返回值与 buildGlossaryRevision 一致，不改变配置的可变语义。
 */
import {buildGlossaryRevision, GLOSSARY_LIMITS, type GlossaryLibrary} from './model';

const unavailable = Symbol('unavailable-glossary-data');
type Primitive = string | number | boolean | undefined;
const libraryTextFields = ['id', 'name', 'sourceLanguage', 'targetLanguage'] as const;
const entryTextFields = ['id', 'source', 'target'] as const;
const libraryTextLimits = {id: 80, name: GLOSSARY_LIMITS.nameLength * 2, sourceLanguage: 40, targetLanguage: 40};

function plainArray(value: unknown, limit: number): value is unknown[] {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
        && value.length <= limit && !Object.hasOwn(value, 'slice') && !Object.hasOwn(value, 'constructor');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** 访问器可能在两次读取之间变值；只复用真实自有数据字段，不代替原始算法调用 getter。 */
function dataField(record: object, key: string | number): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? descriptor.value : unavailable;
}

/** 每个调用者独立持有至多一份镜像，跨调用不信任数组/对象引用或持久化版本号。 */
export function createGlossaryRevisionMemoizer(): (
    libraries: readonly GlossaryLibrary[] | undefined,
    enabled: boolean | undefined,
) => string {
    let mirror: Primitive[] | null = null;
    let revision = '';
    return (libraries, enabled) => {
        if (!enabled) {
            mirror = null;
            revision = '';
            return buildGlossaryRevision(libraries, enabled);
        }
        if (!plainArray(libraries, GLOSSARY_LIMITS.libraries)) return buildGlossaryRevision(libraries, enabled);
        let index = 0;
        let next: Primitive[] | null = null;
        const compare = (value: Primitive) => {
            if (next) next.push(value);
            else if (!mirror || mirror[index] !== value) {
                next = mirror ? mirror.slice(0, index) : [];
                next.push(value);
            }
            index += 1;
        };
        compare(libraries.length);
        let totalEntries = 0;
        for (let libraryIndex = 0; libraryIndex < libraries.length; libraryIndex += 1) {
            const library = dataField(libraries, libraryIndex);
            if (!plainRecord(library)) return buildGlossaryRevision(libraries, enabled);
            for (const key of libraryTextFields) {
                const value = dataField(library, key);
                if (typeof value !== 'string' || value.length > libraryTextLimits[key]) return buildGlossaryRevision(libraries, enabled);
                compare(value);
            }
            const libraryEnabled = dataField(library, 'enabled');
            if (typeof libraryEnabled !== 'boolean') return buildGlossaryRevision(libraries, enabled);
            compare(libraryEnabled);
            const preset = Object.getOwnPropertyDescriptor(library, 'preset');
            if (preset && (!('value' in preset) || preset.value !== undefined)) {
                if (!('value' in preset) || !plainRecord(preset.value)) return buildGlossaryRevision(libraries, enabled);
                const id = dataField(preset.value, 'id'), version = dataField(preset.value, 'version');
                if (typeof id !== 'string' || id.length > 80 || typeof version !== 'number') return buildGlossaryRevision(libraries, enabled);
                compare(id); compare(version);
            } else compare(undefined);
            const domains = dataField(library, 'domains');
            if (!plainArray(domains, GLOSSARY_LIMITS.domainsPerLibrary)) return buildGlossaryRevision(libraries, enabled);
            compare(domains.length);
            for (let domainIndex = 0; domainIndex < domains.length; domainIndex += 1) {
                const domain = dataField(domains, domainIndex);
                if (typeof domain !== 'string' || domain.length > 256) return buildGlossaryRevision(libraries, enabled);
                compare(domain);
            }
            const entries = dataField(library, 'entries');
            if (!plainArray(entries, GLOSSARY_LIMITS.entriesPerLibrary)) return buildGlossaryRevision(libraries, enabled);
            totalEntries += entries.length;
            if (totalEntries > GLOSSARY_LIMITS.totalEntries) return buildGlossaryRevision(libraries, enabled);
            compare(entries.length);
            for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
                const entry = dataField(entries, entryIndex);
                if (!plainRecord(entry)) return buildGlossaryRevision(libraries, enabled);
                for (const key of entryTextFields) {
                    const value = dataField(entry, key);
                    if (typeof value !== 'string' || value.length > (key === 'id' ? 80 : GLOSSARY_LIMITS.termLength * 2)) return buildGlossaryRevision(libraries, enabled);
                    compare(value);
                }
                const caseSensitive = dataField(entry, 'caseSensitive');
                if (typeof caseSensitive !== 'boolean') return buildGlossaryRevision(libraries, enabled);
                compare(caseSensitive);
            }
        }
        // 可变集合的长度及可选 preset 标记均先参与比较，镜像长度变化必然已创建 next。
        if (next) {
            revision = buildGlossaryRevision(libraries, enabled);
            mirror = next;
        }
        return revision;
    };
}

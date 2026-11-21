/**
 * @file src/features/document-translation/core/glossaryCandidates.ts
 * 文件职责：从文档原文提取有证据的英文术语候选，验证用户确认的词条及其适用范围。
 * 主要内容：提取正文定义过的缩写、对应全称及重复出现的专名，保留来源句；复用现有语言范围、重叠判断、配置限额和术语匹配，找出受实际命中变化影响的文档段落。
 * 模块边界：只处理传入的文档分段和词库数据，不请求翻译、写配置或替换译文。
 */
import {
    cleanGlossaryText, createGlossaryEntry, createGlossaryLibrary, findGlossaryMatches, getGlossaryScopeReason,
    glossarySourcesOverlap, GLOSSARY_LIMITS, normalizeGlossaryLanguage, resolveGlossaryEntries,
    type GlossaryContext, type GlossaryEntry, type GlossaryLibrary,
} from '@/src/core/glossary';
import type {DocumentSegment} from './document';

export interface DocumentGlossaryCandidate {
    source: string;
    evidence: string;
    caseSensitive: boolean;
}

export interface DocumentGlossaryChoice extends DocumentGlossaryCandidate {
    target: string;
}

interface DocumentGlossarySettings {
    glossaryEnabled: boolean;
    glossaryLibraries: readonly GlossaryLibrary[];
    documentGlossaryIds: string[] | null;
    from: string;
    to: string;
}

const MAX_CANDIDATES = 12;
const MAX_SCAN_CHARACTERS = 250_000;
const MAX_PARAGRAPH_SCAN = 8_000;
const CONNECTORS = new Set(['a', 'an', 'and', 'for', 'of', 'on', 'the', 'to', 'with']);

function acronymExpansion(sentence: string, position: number, acronym: string): string {
    const prefix = sentence.slice(Math.max(0, position - 160), position).trimEnd();
    const phrase = prefix.match(/[A-Za-z][A-Za-z\d-]*(?: +[A-Za-z][A-Za-z\d-]*){0,11}$/u)?.[0] ?? '';
    const words = phrase.split(' ');
    for (let index = words.length - 2; index >= 0; index -= 1) {
        const expansion = words.slice(index).join(' ');
        const components = expansion.split(/[ -]+/u);
        if (CONNECTORS.has(components[0].toLowerCase())) continue;
        const initials = (parts: string[]) => parts.map(part => part[0]).join('').toUpperCase();
        if (initials(components) === acronym || initials(components.filter(word => !CONNECTORS.has(word.toLowerCase()))) === acronym) {
            return expansion;
        }
    }
    // 连字符连接的几个词可能作为一个整体写在缩写前。
    const last = words[words.length - 1];
    const hyphenated = last.split('-').map(word => word[0]).join('').toUpperCase();
    return hyphenated === acronym ? last : '';
}

function evidenceNear(sentence: string, term: string, index: number): string {
    const start = Math.max(0, index - 80);
    const end = Math.min(sentence.length, start + 320);
    return `${start ? '…' : ''}${sentence.slice(start, Math.max(end, index + term.length)).trim()}${end < sentence.length ? '…' : ''}`;
}

/** 首版以英文显式定义和跨段复现的专名为依据，不把单次首字母大写视为术语。 */
export function extractDocumentGlossaryCandidates(segments: readonly DocumentSegment[]): DocumentGlossaryCandidate[] {
    const definitions = new Map<string, DocumentGlossaryCandidate>();
    const names = new Map<string, {candidate: DocumentGlossaryCandidate; lastParagraph: number; count: number}>();
    let budget = MAX_SCAN_CHARACTERS;
    for (const {id, source} of segments) {
        if (budget <= 0) break;
        const text = source.slice(0, Math.min(MAX_PARAGRAPH_SCAN, budget));
        budget -= text.length;
        for (const raw of text.split(/(?<=[.!?])\s+|\n+/u)) {
            const sentence = raw.replace(/\s+/gu, ' ').trim();
            for (const match of sentence.matchAll(/\(([A-Z][A-Z\d]{1,7})\)/gu)) {
                const acronym = match[1];
                const expansion = acronymExpansion(sentence, match.index, acronym);
                if (!expansion) continue;
                const evidence = evidenceNear(sentence, expansion, match.index - expansion.length - 1);
                definitions.set(expansion.toLowerCase(), {source: expansion, evidence, caseSensitive: false});
                definitions.set(acronym.toLowerCase(), {source: acronym, evidence, caseSensitive: true});
            }
            for (const match of sentence.matchAll(/\b[A-Z][a-z]{2,}(?: +[A-Z][a-z]{2,}){1,3}\b/gu)) {
                const name = match[0];
                if (name.length > GLOSSARY_LIMITS.termLength) continue;
                const key = name.toLowerCase();
                const previous = names.get(key);
                if (previous) {
                    if (previous.lastParagraph !== id) ++previous.count;
                    previous.lastParagraph = id;
                } else {
                    names.set(key, {candidate: {source: name, evidence: evidenceNear(sentence, name, match.index), caseSensitive: true},
                        lastParagraph: id, count: 1});
                }
            }
        }
    }
    return [...definitions.values(), ...[...names.entries()].filter(([name, info]) => info.count > 1 && !definitions.has(name))
        .sort(([, left], [, right]) => right.count - left.count).map(([, {candidate}]) => candidate)].slice(0, MAX_CANDIDATES);
}

function documentContext(settings: DocumentGlossarySettings, text: string | string[], scope = settings.documentGlossaryIds): GlossaryContext {
    return {text, sourceLanguage: settings.from, targetLanguage: settings.to, glossaryIds: scope};
}

export function documentGlossaryDestinations(settings: DocumentGlossarySettings): GlossaryLibrary[] {
    const context = documentContext(settings, '');
    return settings.glossaryLibraries.filter(library => {
        const reason = getGlossaryScopeReason(library, context);
        return reason === 'eligible' || reason === 'empty';
    });
}

export function filterDocumentGlossaryCandidates(settings: DocumentGlossarySettings, candidates: readonly DocumentGlossaryCandidate[]): DocumentGlossaryCandidate[] {
    const existing = documentGlossaryDestinations(settings).flatMap(library => library.entries);
    return candidates.filter(candidate => !existing.some(entry => glossarySourcesOverlap(entry, candidate)));
}

export type DocumentGlossaryPlan =
    | {error: 'library' | 'capacity' | 'entry'}
    | {glossaryLibraries: GlossaryLibrary[]; documentGlossaryIds: string[] | null; glossaryEnabled: true; affectedIds: Set<number>};

export function planDocumentGlossaryUpdate(settings: DocumentGlossarySettings, segments: readonly DocumentSegment[],
    choices: readonly DocumentGlossaryChoice[], libraryId: string, newLibraryName: string): DocumentGlossaryPlan {
    const libraries = settings.glossaryLibraries;
    const destination = libraryId ? documentGlossaryDestinations(settings).find(library => library.id === libraryId) : undefined;
    if (libraryId && !destination) return {error: 'library'};
    if (!destination && libraries.length >= GLOSSARY_LIMITS.libraries) return {error: 'capacity'};
    const sourceLanguage = normalizeGlossaryLanguage(settings.from) || 'en';
    const targetLanguage = normalizeGlossaryLanguage(settings.to);
    const library = destination ? {...destination, entries: [...destination.entries]} : {
        ...createGlossaryLibrary(libraries), name: newLibraryName, sourceLanguage, targetLanguage,
    };
    const existing = documentGlossaryDestinations(settings).flatMap(item => item.entries);
    const added: GlossaryEntry[] = [];
    for (const choice of choices) {
        const source = cleanGlossaryText(choice.source), target = cleanGlossaryText(choice.target);
        if (!source || !target || Array.from(source).length > GLOSSARY_LIMITS.termLength ||
            Array.from(target).length > GLOSSARY_LIMITS.termLength ||
            [...existing, ...added].some(entry => glossarySourcesOverlap(entry, choice))) return {error: 'entry'};
        const entry = {...createGlossaryEntry(library.entries), source, target, caseSensitive: choice.caseSensitive};
        library.entries.push(entry);
        added.push(entry);
    }
    if (!added.length) return {error: 'entry'};
    if (library.entries.length > GLOSSARY_LIMITS.entriesPerLibrary ||
        added.length + libraries.reduce((count, item) => count + item.entries.length, 0) > GLOSSARY_LIMITS.totalEntries) return {error: 'capacity'};
    const glossaryLibraries = destination ? libraries.map(item => item.id === library.id ? library : item) : [...libraries, library];
    const documentGlossaryIds = settings.documentGlossaryIds && !destination ? [...settings.documentGlossaryIds, library.id] : settings.documentGlossaryIds;
    const additions = settings.glossaryEnabled ? added : documentGlossaryDestinations({...settings, glossaryLibraries, documentGlossaryIds}).flatMap(item => item.entries);
    const affectedIds = new Set<number>();
    for (const {id, source} of segments) {
        const text = source.normalize('NFC');
        if (!findGlossaryMatches(text, additions).length) continue;
        const after = resolveGlossaryEntries(glossaryLibraries, documentContext(settings, text, documentGlossaryIds)).terms;
        const before = settings.glossaryEnabled ? resolveGlossaryEntries(libraries, documentContext(settings, text)).terms : [];
        if (JSON.stringify(before) !== JSON.stringify(after)) affectedIds.add(id);
    }
    return {glossaryEnabled: true, glossaryLibraries, documentGlossaryIds, affectedIds};
}

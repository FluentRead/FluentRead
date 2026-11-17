/**
 * @file src/features/selection-translation/dictionary/service.ts
 * 文件职责：按用户主动选定的词典配方查询 API、本地词库或网页来源，并转换为现有词卡数据。
 * 主要内容：有界 HTTP 读取、按配方隔离的短期缓存和在途合并，按需加载本地索引及脚本引擎；媒体只从用户导入的资源读取。
 * 模块边界：后台查询服务不渲染 HTML、不改变选区和配置；来源能力由经过校验的配方提供。
 */
import {dictionaryUrl, validateDictionaryRecipe, EMPTY_DICTIONARY_FIELDS, type DictionaryRecipe} from '@/src/core/config/dictionaryWorkspace';
import {createRuntimeAbortContext, runtimeFetch, cancelUnreadResponseBody, cancelResponseReader} from '@/src/platform/http/runtime';
import type {WordCardData} from '../services/wordDictionary';
import {dictionaryPlainText, mapDictionaryResponse, normalizeDictionaryWord, type DictionaryEntry} from './model';

const cache = new Map<string, {until: number; card: WordCardData | null}>();
const pending = new Map<string, Promise<WordCardData | null>>();
export async function readDictionaryJson(response: Response, maxBytes = 1024 * 1024): Promise<unknown> {
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
        cancelUnreadResponseBody(response); throw new Error('Dictionary response failed or is too large');
    }
    if (!response.body) throw new Error('Dictionary response is empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.length; if (size > maxBytes) throw new Error('Dictionary response is too large');
            chunks.push(chunk.value);
        }
    } catch (error) {cancelResponseReader(reader); throw error;}
    reader.releaseLock();
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
}
function toCard(entry: DictionaryEntry, recipe: DictionaryRecipe): WordCardData {
    let audio: string | undefined;
    if (entry.audio) {try {const url = new URL(entry.audio); if (url.protocol === 'https:' && !url.username && !url.password) audio = url.href;} catch { /* 无效音频保留文本和系统朗读。 */ }}
    return {word: entry.word, normalizedWord: normalizeDictionaryWord(entry.word) || entry.word, phonetics: entry.phonetic || audio ? [{text: entry.phonetic, audio}] : [],
        meanings: entry.definition ? [{partOfSpeech: '', definitions: [{definition: entry.definition, ...(entry.example ? {example: entry.example} : {})}]}] : [],
        origin: entry.etymology || undefined, sources: [{id: `recipe:${recipe.id}`, label: recipe.name, url: entry.sourceUrl}], dictionaryEntry: entry};
}
const mediaTypes: Record<string, string> = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', woff: 'font/woff', woff2: 'font/woff2'};
async function localEntry(recipe: DictionaryRecipe, word: string): Promise<DictionaryEntry | null> {
    const {DictionaryRepository} = await import('@/src/platform/storage/dictionaryRepository');
    const database = new DictionaryRepository();
    try {
        let {metadata, entries} = await database.lookup(recipe.localId, word);
        const aliases = new Set([word]);
        for (let depth = 0; entries.length === 1 && entries[0].html.startsWith('@@@LINK='); depth++) {
            const target = normalizeDictionaryWord(entries[0].html.slice(8).trim());
            if (!target || aliases.has(target) || depth >= 8) throw new Error('Invalid local dictionary alias');
            aliases.add(target);
            ({metadata, entries} = await database.lookup(recipe.localId, target));
        }
        if (!entries.length) return null;
        let html = entries.map(item => item.html).join('<hr>'), css = metadata.css;
        const paths = [...new Set([...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi), ...css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)].map(match => match[1]))].slice(0, 32);
        let total = 0;
        for (const path of paths) {
            const clean = path.replace(/^(?:sound|file):\/\//i, '').replaceAll('\\', '/').replace(/^\/+/, '');
            if (clean.split('/').includes('..')) continue;
            const resource = await database.resources.get([recipe.localId, clean]);
            if (resource && /\.css$/i.test(clean) && resource.bytes.length <= 262144) {css += `\n${new TextDecoder().decode(resource.bytes)}`; continue;}
            const mime = mediaTypes[clean.slice(clean.lastIndexOf('.') + 1).toLowerCase()];
            if (!resource || !mime || resource.bytes.length > 1024 * 1024 || total + resource.bytes.length > 2 * 1024 * 1024) continue;
            total += resource.bytes.length;
            let binary = ''; for (const byte of resource.bytes) binary += String.fromCharCode(byte);
            const url = `data:${mime};base64,${btoa(binary)}`;
            html = html.replaceAll(path, url); css = css.replaceAll(path, url);
        }
        return {...EMPTY_DICTIONARY_FIELDS, word: entries[0].word, phonetic: entries[0].phonetic,
            definition: entries.map(item => item.definition).join('\n'), html, css, source: recipe.name, sourceUrl: ''};
    } finally {database.close();}
}
async function query(recipe: DictionaryRecipe, word: string): Promise<WordCardData | null> {
    if (recipe.kind === 'local') {const entry = await localEntry(recipe, word); return entry ? toCard(entry, recipe) : null;}
    const url = dictionaryUrl(recipe.url, word);
    if (recipe.kind === 'iframe') return toCard({...EMPTY_DICTIONARY_FIELDS, word, webUrl: url, source: recipe.name, sourceUrl: url}, recipe);
    const abort = createRuntimeAbortContext(2500);
    try {
        const response = await runtimeFetch(url, {headers: recipe.headers, signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'});
        let data = await readDictionaryJson(response);
        if (recipe.kind === 'script') {
            const {runDictionaryScript} = await import('./script');
            data = await runDictionaryScript(recipe.script, word, data);
        }
        const entry = mapDictionaryResponse(data, recipe, word);
        if (!entry.definition && !entry.phonetic && !entry.example) return null;
        entry.definition = dictionaryPlainText(entry.definition);
        return toCard(entry, recipe);
    } finally {abort.cleanup();}
}
export async function lookupDictionaryRecipe(text: string, input: DictionaryRecipe): Promise<WordCardData | null> {
    const word = normalizeDictionaryWord(text);
    if (!word) return null;
    const recipe = validateDictionaryRecipe(input);
    const key = JSON.stringify([recipe, word]);
    const cached = cache.get(key);
    if (cached && cached.until > Date.now() && recipe.kind !== 'local') return structuredClone(cached.card);
    const existing = pending.get(key); if (existing) return structuredClone(await existing);
    const request = query(recipe, word);
    pending.set(key, request);
    try {
        const card = await request;
        if (cache.size >= 32) cache.delete(cache.keys().next().value!);
        cache.set(key, {until: Date.now() + 5 * 60_000, card});
        return structuredClone(card);
    } finally {pending.delete(key);}
}

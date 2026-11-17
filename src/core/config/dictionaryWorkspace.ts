/**
 * @file src/core/config/dictionaryWorkspace.ts
 * 文件职责：定义可分享词典配方、结构化卡片字段和本地卡片模板的纯配置契约。
 * 主要内容：校验来源地址、字段路径、请求头、脚本及模板的容量；导入时拒绝错误配方，分享时去除凭据。
 * 模块边界：不请求词典、不执行脚本、不导入本地文件；配置由现有配置服务保存。
 */
export const DICTIONARY_FIELDS = ['definition', 'phonetic', 'audio', 'example', 'etymology', 'inflections'] as const;
export type DictionaryField = typeof DICTIONARY_FIELDS[number];
export type DictionaryFields = Record<DictionaryField, string>;
export interface DictionaryRecipe {
    id: string;
    name: string;
    kind: 'json' | 'iframe' | 'script' | 'local';
    url: string;
    headers: Record<string, string>;
    fields: DictionaryFields;
    script: string;
    localId: string;
}
export interface DictionaryWorkspace {
    revision: number;
    recipes: DictionaryRecipe[];
    front: string;
    back: string;
    anki: {url: string; deck: string; model: string; frontField: string; backField: string};
}
export const EMPTY_DICTIONARY_FIELDS: DictionaryFields = {definition: '', phonetic: '', audio: '', example: '', etymology: '', inflections: ''};
export function defaultDictionaryWorkspace(): DictionaryWorkspace {
    return {revision: 0, recipes: [], front: '{{word}}\n{{phonetic}}', back: '{{definition}}\n\n{{example}}\n\n{{context_sentence}}',
        anki: {url: 'http://127.0.0.1:8765/', deck: 'Default', model: 'Basic', frontField: 'Front', backField: 'Back'}};
}
export function dictionaryObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function dictionaryText(value: unknown, limit = 8192): string {
    return typeof value === 'string' ? value.slice(0, limit).trim() : '';
}
export function dictionaryId(value: unknown): string {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : '';
}
/** HTTP 仅允许回环地址；分享配方不能把本地任意协议变成可调用能力。 */
export function dictionaryUrl(value: string, word?: string): string {
    const url = new URL(word === undefined ? value.replaceAll('{{word}}', 'fluentread') : value.replaceAll('{{word}}', encodeURIComponent(word)));
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('Dictionary URL must use HTTPS or a loopback HTTP address');
    }
    return word === undefined ? value : url.href;
}
export function validateDictionaryRecipe(value: unknown): DictionaryRecipe {
    if (!dictionaryObject(value) || !dictionaryId(value.id) || !dictionaryText(value.name, 80)
        || !['json', 'iframe', 'script', 'local'].includes(String(value.kind))) throw new Error('Invalid dictionary recipe');
    const kind = value.kind as DictionaryRecipe['kind'];
    const url = dictionaryText(value.url, 2048);
    const localId = dictionaryId(value.localId);
    if (kind === 'local') {if (!localId) throw new Error('Missing local dictionary');}
    else if (!url || !url.includes('{{word}}')) throw new Error('Dictionary URL needs {{word}}');
    else dictionaryUrl(url);
    const headers: Record<string, string> = {};
    if (dictionaryObject(value.headers)) {
        if (Object.keys(value.headers).length > 16) throw new Error('Too many dictionary headers');
        for (const [key, item] of Object.entries(value.headers)) {
            if (!/^[\w-]{1,64}$/.test(key) || /^(cookie|host|origin|referer|sec-|proxy-)/i.test(key)
                || typeof item !== 'string' || item.length > 4096 || /[\r\n]/.test(item)) throw new Error('Invalid dictionary header');
            headers[key] = item;
        }
    }
    const fields = {...EMPTY_DICTIONARY_FIELDS};
    if (dictionaryObject(value.fields)) for (const field of DICTIONARY_FIELDS) fields[field] = dictionaryText(value.fields[field], 256);
    const script = dictionaryText(value.script, 16384);
    if (kind === 'script' && !script) throw new Error('Missing dictionary script');
    return {id: value.id as string, name: dictionaryText(value.name, 80), kind, url, headers, fields, script, localId};
}
export function normalizeDictionaryWorkspace(value: unknown): DictionaryWorkspace {
    const result = defaultDictionaryWorkspace();
    if (!dictionaryObject(value)) return result;
    if (typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0) result.revision = value.revision;
    const ids = new Set<string>();
    if (Array.isArray(value.recipes)) for (const candidate of value.recipes.slice(0, 32)) {
        try {const recipe = validateDictionaryRecipe(candidate); if (!ids.has(recipe.id)) {result.recipes.push(recipe); ids.add(recipe.id);}}
        catch { /* 无效旧配置不授予网络或脚本能力，严格导入入口另行报告错误。 */ }
    }
    if (typeof value.front === 'string') result.front = value.front.slice(0, 16384);
    if (typeof value.back === 'string') result.back = value.back.slice(0, 16384);
    if (dictionaryObject(value.anki)) {
        for (const field of ['deck', 'model', 'frontField', 'backField'] as const) result.anki[field] = dictionaryText(value.anki[field], 120) || result.anki[field];
        try {
            const url = new URL(dictionaryText(value.anki.url, 512));
            if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password) result.anki.url = url.href;
        } catch { /* 保留回环默认值。 */ }
    }
    return result;
}
export function importDictionaryRecipes(text: string): DictionaryRecipe[] {
    if (text.length > 1024 * 1024) throw new Error('Recipe file is too large');
    const value: unknown = JSON.parse(text);
    if (!dictionaryObject(value) || value.version !== 1 || !Array.isArray(value.recipes) || value.recipes.length > 32) throw new Error('Invalid dictionary recipe file');
    const recipes = value.recipes.map(validateDictionaryRecipe);
    if (new Set(recipes.map(recipe => recipe.id)).size !== recipes.length) throw new Error('Duplicate dictionary recipe ID');
    return recipes;
}
export function exportDictionaryRecipes(recipes: readonly DictionaryRecipe[]): string {
    return JSON.stringify({version: 1, recipes: recipes.filter(recipe => recipe.kind !== 'local').map(recipe => ({...recipe, headers: {}}))}, null, 2);
}

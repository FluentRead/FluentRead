/**
 * @file src/features/selection-translation/dictionary/model.ts
 * 文件职责：实现词典配方字段提取、无执行能力的卡片模板及导出正文。
 * 主要内容：支持点号、数组下标和通配符路径，拒绝原型路径；只替换已知占位符，提供 CSV 和 Markdown 导出。
 * 模块边界：纯数据转换，不读取配置、不加载词库、不渲染 HTML 或调用 Anki。
 */
import {DICTIONARY_FIELDS, dictionaryText, type DictionaryFields, type DictionaryRecipe, type DictionaryWorkspace} from '@/src/core/config/dictionaryWorkspace';
import {decodeHTML} from 'entities';

export interface DictionaryEntry extends DictionaryFields {word: string; html?: string; css?: string; webUrl?: string; source: string; sourceUrl: string}
export interface DictionaryCardFields extends DictionaryFields {word: string; ai_explanation: string; context_sentence: string; source: string; source_url: string}
export function normalizeDictionaryWord(value: string): string | null {
    const word = value.trim().normalize('NFC');
    return word.length > 0 && word.length <= 128 && /^[\p{L}\p{M}\p{N}]+(?:[ '\u2019\-][\p{L}\p{M}\p{N}]+)*$/u.test(word) ? word.toLowerCase() : null;
}
export function dictionaryPlainText(value: string): string {
    return decodeHTML(value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/[\t\r ]+/g, ' ').trim().slice(0, 32768);
}
/** 只解析数据路径，不执行 JSONPath 过滤器或 JavaScript 表达式。 */
export function dictionaryPath(data: unknown, path: string): string {
    if (!path.trim()) return '';
    const normalized = path.trim().replace(/^\$\.(?!\.)|^\$(?!\.)/, '').replace(/\[(\d+|\*)\]/g, '.$1').replace(/^\./, '');
    if (!/^(?:[\w-]+|\*)(?:\.(?:[\w-]+|\*))*$/.test(normalized)) throw new Error('Invalid dictionary field path');
    const tokens = normalized.split('.');
    if (tokens.some(token => ['__proto__', 'prototype', 'constructor'].includes(token)) || tokens.length > 20) throw new Error('Invalid dictionary field path');
    let values: unknown[] = [data];
    for (const token of tokens) {
        values = values.flatMap(value => {
            if (!value || typeof value !== 'object') return [];
            if (token === '*') return Array.isArray(value) ? value.slice(0, 100) : Object.values(value).slice(0, 100);
            return Object.hasOwn(value, token) ? [(value as Record<string, unknown>)[token]] : [];
        }).slice(0, 100);
    }
    return values.flatMap(value => Array.isArray(value) ? value : [value])
        .filter(value => ['string', 'number', 'boolean'].includes(typeof value)).map(value => String(value)).join('\n').slice(0, 32768);
}
export function mapDictionaryResponse(data: unknown, recipe: DictionaryRecipe, word: string): DictionaryEntry {
    const fields = Object.fromEntries(DICTIONARY_FIELDS.map(field => [field, dictionaryPlainText(dictionaryPath(data, recipe.fields[field]))])) as unknown as DictionaryFields;
    // 音频路径是 URL，不进行 HTML 实体清洗；播放由已有朗读链路处理。
    fields.audio = dictionaryPath(data, recipe.fields.audio).split('\n')[0] || '';
    return {...fields, word, source: recipe.name, sourceUrl: recipe.url.replaceAll('{{word}}', encodeURIComponent(word))};
}
export function cardTemplate(template: string, fields: DictionaryCardFields): string {
    return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, name: string) => Object.hasOwn(fields, name) ? fields[name as keyof DictionaryCardFields] : '');
}
export function dictionaryCard(entry: DictionaryEntry, context: string, explanation: string, workspace: DictionaryWorkspace): {front: string; back: string} {
    const fields: DictionaryCardFields = {...entry, ai_explanation: dictionaryText(explanation, 32768), context_sentence: dictionaryText(context, 4000), source_url: entry.sourceUrl};
    return {front: cardTemplate(workspace.front, fields), back: cardTemplate(workspace.back, fields)};
}
export function dictionaryCsv(card: {front: string; back: string}): string {
    const cell = (text: string) => `"${(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
    return `Front,Back\r\n${cell(card.front)},${cell(card.back)}\r\n`;
}
export function dictionaryMarkdown(card: {front: string; back: string}): string {
    return `${card.front}\n\n---\n\n${card.back}\n`;
}

/**
 * @file src/features/selection-translation/dictionary/anki.ts
 * 文件职责：将用户主动提交的双面学习卡发送到本机 AnkiConnect。
 * 主要内容：限定回环服务和字段长度，转义卡片 HTML，拒绝 Anki 错误与空结果，避免静默重复提交。
 * 模块边界：复用统一 HTTP 端口，不保存凭据、不自动创建牌组、不读取词书或页面内容。
 */
import {normalizeDictionaryWorkspace, type DictionaryWorkspace} from '@/src/core/config/dictionaryWorkspace';
import {createRuntimeAbortContext, runtimeFetch} from '@/src/platform/http/runtime';
import {readDictionaryJson} from './service';
export async function sendDictionaryCardToAnki(card: {front: string; back: string}, settings: DictionaryWorkspace['anki']): Promise<number> {
    const normalized = normalizeDictionaryWorkspace({anki: settings}).anki;
    if (normalized.url !== new URL(settings.url).href || !card.front.trim() || !card.back.trim() || card.front.length > 65536 || card.back.length > 65536) throw new Error('Invalid Anki card or endpoint');
    const html = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\n', '<br>');
    const abort = createRuntimeAbortContext(5000);
    try {
        const response = await runtimeFetch(normalized.url, {method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'omit', redirect: 'error', signal: abort.signal,
            body: JSON.stringify({action: 'addNote', version: 6, params: {note: {deckName: normalized.deck, modelName: normalized.model,
                fields: {[normalized.frontField]: html(card.front), [normalized.backField]: html(card.back)}, options: {allowDuplicate: false}, tags: ['FluentRead']}}})});
        const result = await readDictionaryJson(response, 65536) as {result?: unknown; error?: unknown};
        if (!result || result.error || typeof result.result !== 'number') throw new Error('AnkiConnect did not confirm the card');
        return result.result;
    } finally {abort.cleanup();}
}

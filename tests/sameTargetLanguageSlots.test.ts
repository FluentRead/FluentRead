/**
 * @file tests/sameTargetLanguageSlots.test.ts
 * 全文富文本槽与批量请求在真实语言识别下的一致性：谷歌/微软批量、免费聚合会话缓存、普通供应商文本包、本地模型逐槽、
 * AI 跨候选合并与 $$$ 公式拆分都只提交未被同一判断跳过的槽，并按原索引回填；是否配置排除语言不改变识别深度；
 * 快照切换目标或排除语言后重新判断，不复用旧会话结果；补充证据仅检查组包前原文，取消与失败重试同样只涉及外语槽。只替换翻译客户端、异步补充证据与配置存储。
 * 批译缓存通过真实请求入口计数 slot key 序列化，覆盖不同原文、重复原文和部分已结算命中，并核对缓存身份与回填结果。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import technicalParagraphs from './fixtures/chinese-technical-paragraphs.json';

const runtime = vi.hoisted(() => ({
    requests: [] as Array<{kind: 'text' | 'batch'; origins: string[]; options: Record<string, unknown>}>,
    textContexts: [] as string[],
    fail: 0,
    nextError: undefined as unknown,
    pending: null as null | {resolve: () => void},
    preflight: vi.fn<(text: string, target: string, excluded: readonly string[], signal?: AbortSignal) => Promise<boolean>>(),
    config: {
        service: 'microsoft',
        model: {microsoft: 'default', openai: 'gpt-test'} as Record<string, string>,
        customModel: {} as Record<string, string>,
        modelThinking: {} as Record<string, Record<string, boolean>>,
        from: 'auto',
        to: 'de',
        excludedLanguages: [] as string[],
        useCache: true,
        enableAIContext: false,
        enableAIMultiSegment: false,
        display: 1,
        style: 0,
        maxConcurrentTranslations: 2,
        glossaryLibraries: [],
        glossaryEnabled: false,
    },
}));

async function respond(kind: 'text' | 'batch', origins: string[], options: Record<string, unknown>): Promise<string[]> {
    runtime.requests.push({kind, origins, options});
    if (runtime.nextError) {
        const error = runtime.nextError;
        runtime.nextError = undefined;
        throw error;
    }
    if (runtime.fail > 0) {
        runtime.fail -= 1;
        throw new Error('provider unavailable');
    }
    if (runtime.pending) await new Promise<void>(resolve => { runtime.pending = {resolve}; });
    // 文本包按协议保留标记，只翻译标记内的槽内容。
    return origins.map(origin => origin.startsWith('___FLUENTREAD_')
        ? origin.replace(/(_\d+_BEGIN___)([\s\S]*?)(___FLUENTREAD_)/gu, (_match, begin, content, end) => `${begin}T:${content}${end}`)
        : `T:${origin}`);
}

vi.mock('@/src/services/config/store', () => ({config: runtime.config}));
vi.mock('@/src/services/translation/languagePreflight', () => ({shouldSkipTranslationWithEvidence: runtime.preflight}));
vi.mock('@/src/services/translation/client', () => ({
    translateText: async (origin: string, context: string, options: Record<string, unknown>) => {
        runtime.textContexts.push(context);
        return (await respond('text', [origin], options))[0];
    },
    translateTextBatch: (origins: readonly string[], _context: string, options: Record<string, unknown>) =>
        respond('batch', [...origins], options),
}));

import {
    captureFullPageTranslationConfig,
    clearFullPageTranslationRequestCache,
    createSnapshotTranslateOptions,
    tryTranslateInlineCodeSentence,
    translateTextSlots,
    type FullPageTranslationSessionCache,
} from '@/src/features/full-page-translation/content/translationRequest';
import {createFullPageRequestSessionState} from '@/src/features/full-page-translation/content/requestSession';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {TranslationRequestError, TRANSLATION_ERROR_MARKER} from '@/src/services/translation/errors';
import {collectLiveTranslationTextSlots, extractTranslationText, serializeTranslationSlots} from '@/src/core/translation/public';

const german = 'Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.';
const english = 'This English sentence still needs a German translation for the reader.';
const japanese = 'GPT-6 Sol の新しいモデルを発表しました。';
const chinese = '云端模型清单允许清空，且不再连带拒掉无关偏好的保存 (84522b3)';
const shortGermanLink = 'Mehr';
const origins = [german, english, japanese, shortGermanLink, chinese, '84522b3', ''];
const unknownEnglish = 'Astronomical instruments capture electromagnetic radiation across distant interstellar regions enabling detailed spectroscopic measurements alongside sophisticated computational simulations.';
const otherUnknownEnglish = 'Photographic collections document extraordinary architectural landscapes throughout remarkable Mediterranean villages alongside magnificent historical monuments.';
const deferredBoolean = () => {
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => {resolve = done;});
    return {promise, resolve};
};

function submitted(): string[] {
    return runtime.requests.flatMap(request => request.origins.flatMap(origin => origin.startsWith('___FLUENTREAD_')
        ? [...origin.matchAll(/___FLUENTREAD_[^_]+_\d+_BEGIN___([\s\S]*?)___FLUENTREAD_[^_]+_\d+_END___/gu)].map(match => match[1]!)
        : [origin]));
}

beforeEach(() => {
    vi.stubGlobal('document', {title: 'Release notes', location: {href: 'https://example.test/releases'}, URL: 'https://example.test/releases'});
    runtime.requests = [];
    runtime.textContexts = [];
    runtime.fail = 0;
    runtime.nextError = undefined;
    runtime.pending = null;
    runtime.preflight.mockReset().mockResolvedValue(false);
    Object.assign(runtime.config, {service: 'microsoft', from: 'auto', to: 'de', excludedLanguages: [], enableAIMultiSegment: false,
        enableAIContext: false, glossaryEnabled: false, glossaryLibraries: []});
});

describe('原始槽的补充证据与快照', () => {
    it('自动源语言下日文受标记影响变成混合语时回退，不改变源语言', async () => {
        Object.assign(runtime.config, {service: 'myMemory', from: 'auto', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const source = '変数 __FRCODE_0123456789abcdef_0__ は同じではありません。';
        const detectionText = '変数   は同じではありません。';
        expect(identifyTextLanguage(detectionText)).toMatchObject({status: 'identified', languages: ['ja']});
        expect(identifyTextLanguage(source).status).toBe('mixed');
        expect(await tryTranslateInlineCodeSentence(source, () => ['a', 'b'], captureFullPageTranslationConfig())).toBeNull();
        expect(runtime.requests).toEqual([]);
        expect(runtime.preflight).not.toHaveBeenCalled();
    });

    it('MDN 英文在自动源语言下标记前后识别一致，试探保留原 auto 配置', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', from: 'auto', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const source = 'But, the variable __FRCODE_0123456789abcdef_0__ is not the same as __FRCODE_0123456789abcdef_1__ because JavaScript is case sensitive.';
        const detectionText = 'But, the variable   is not the same as   because JavaScript is case sensitive.';
        expect(identifyTextLanguage(detectionText)).toMatchObject({status: 'identified', languages: ['en']});
        expect(identifyTextLanguage(source)).toMatchObject({status: 'identified', languages: ['en']});
        expect(await tryTranslateInlineCodeSentence(source, () => ['a', 'b', 'c'], captureFullPageTranslationConfig())).toEqual(['a', 'b', 'c']);
        expect(runtime.requests[0]?.options.sourceLanguage).toBe('auto');
        expect(runtime.requests[0]?.options.sourceLanguageDetectionText).toBe(detectionText);
    });

    it('显式源语言不会被试探门禁覆盖或重设', async () => {
        Object.assign(runtime.config, {service: 'myMemory', from: 'ja', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const source = '変数 __FRCODE_0123456789abcdef_0__ は同じではありません。';
        expect(await tryTranslateInlineCodeSentence(source, () => ['a', 'b'], captureFullPageTranslationConfig())).toEqual(['a', 'b']);
        expect(runtime.requests[0]?.options.sourceLanguage).toBe('ja');
    });

    it('按默认术语保护后的 UTF-8 长度限制行内代码试探', async () => {
        Object.assign(runtime.config, {from: 'en', to: 'zh-Hans'});
        const source = `Read __FRCODE_0123456789abcdef_0__ and ${'call the API. '.repeat(25)}`;
        expect(new TextEncoder().encode(source).length).toBeLessThan(450);
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], captureFullPageTranslationConfig())).toBeNull();
        expect(runtime.requests).toEqual([]);
    });

    it('行内代码试探只发送标记正文，以无标记文字检测语言并冻结缓存设置', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const snapshot = captureFullPageTranslationConfig();
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different from __FRCODE_0123456789abcdef_1__.';
        const decode = vi.fn((value: string) => value.startsWith('T:') ? ['变量', '不同', '。'] : null);
        const result = await tryTranslateInlineCodeSentence(source, decode, snapshot);
        expect(result).toEqual(['变量', '不同', '。']);
        expect(runtime.preflight).toHaveBeenCalledWith('The variable   is different from  .', 'zh-Hans', [], undefined);
        expect(runtime.requests).toHaveLength(1);
        expect(runtime.textContexts).toEqual(['']);
        expect(runtime.requests[0]).toMatchObject({kind: 'text', origins: [source], options: {
            serviceOverride: 'freeTranslation', useCache: true, validateInlineCodeTranslation: true, skipLanguageDetection: true,
            sourceLanguageDetectionText: 'The variable   is different from  .', enableAIContext: false,
        }});
        expect(decode).toHaveBeenCalledWith(`T:${source}`);
        runtime.requests.length = 0;
        await tryTranslateInlineCodeSentence(source, decode, {...snapshot, useCache: false});
        expect(runtime.requests[0]?.options).toMatchObject({useCache: false, validateInlineCodeTranslation: true});
    });

    it('试探遵守目标与排除语言、上下文开关和无效响应回退', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        const snapshot = captureFullPageTranslationConfig();
        runtime.preflight.mockResolvedValueOnce(true);
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot)).toBeNull();
        expect(runtime.requests).toEqual([]);
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], {...snapshot, enableAIContext: true})).toBeNull();
        expect(await tryTranslateInlineCodeSentence(source, () => null, snapshot)).toBeNull();
        expect(runtime.requests).toHaveLength(1);
        expect(await tryTranslateInlineCodeSentence('The variable __FRCODE_invalid__ is different.', () => ['ignored'], snapshot)).toBeNull();
        expect(runtime.requests).toHaveLength(1);
    });

    it.each([
        '__FRCODE_0123456789abcdef_0__   ',
        'The variable __FRCODE_0123456789abcdef_0__ and __FRCODE_invalid__ are different.',
    ])('标记之外没有正文或仍有不完整标记时不发送试探', async source => {
        Object.assign(runtime.config, {from: 'en', to: 'zh-Hans'});
        const decode = vi.fn();
        expect(await tryTranslateInlineCodeSentence(source, decode, captureFullPageTranslationConfig())).toBeNull();
        expect(runtime.preflight).not.toHaveBeenCalled();
        expect(runtime.requests).toEqual([]);
        expect(decode).not.toHaveBeenCalled();
    });

    it('实际术语可能覆盖标记或词库版本变化时不发送试探', async () => {
        const marker = '__FRCODE_0123456789abcdef_0__';
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: true, enableAIContext: false,
            glossaryLibraries: [{id: 'terms', name: 'terms', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [],
                entries: [{id: 'marker', source: marker, target: 'replacement', caseSensitive: true}]}]});
        const source = `The variable ${marker} is different.`;
        const snapshot = captureFullPageTranslationConfig();
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot)).toBeNull();
        expect(runtime.requests).toEqual([]);
        Object.assign(runtime.config, {glossaryLibraries: []});
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot)).toBeNull();
        expect(runtime.requests).toEqual([]);
    });

    it('不适用的长术语不能掩盖另一个词条跨越标记的命中', async () => {
        const marker = '__FRCODE_0123456789abcdef_0__';
        const longPrefix = 'These words describe a long technical description of the following variable';
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: true, enableAIContext: false,
            glossaryLibraries: [{id: 'terms', name: 'terms', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [],
                entries: [{id: 'long', source: longPrefix, target: 'x', caseSensitive: true},
                    {id: 'cross', source: `variable ${marker}`, target: 'y', caseSensitive: true}]}]});
        const source = `${longPrefix} ${marker} is different.`;
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], captureFullPageTranslationConfig())).toBeNull();
        expect(runtime.requests).toEqual([]);
    });

    it('普通正文命中术语时回退，避免后台替换扩张整句', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: true, enableAIContext: false,
            glossaryLibraries: [{id: 'terms', name: 'terms', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [],
                entries: [{id: 'term', source: 'variable', target: '变量', caseSensitive: false}]}]});
        const snapshot = captureFullPageTranslationConfig();
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        expect(await tryTranslateInlineCodeSentence(source, () => ['a', 'b'], snapshot)).toBeNull();
        expect(runtime.requests).toEqual([]);
    });

    it('启用词库但没有词条命中时仍可试探', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: true, enableAIContext: false,
            glossaryLibraries: [{id: 'terms', name: 'terms', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [],
                entries: [{id: 'term', source: 'keyboard', target: '键盘', caseSensitive: false}]}]});
        const snapshot = captureFullPageTranslationConfig();
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        expect(await tryTranslateInlineCodeSentence(source, () => ['a', 'b'], snapshot)).toEqual(['a', 'b']);
        expect(runtime.requests[0]?.options.glossaryRevision).toBe(snapshot.glossaryRevision);
        expect(runtime.requests[0]?.options.glossaryIds).toEqual(snapshot.glossaryIds);
    });

    it.each([[64, true], [65, false]])('启用 %i 个未命中术语时按词库上限决定是否试探', async (count, allowed) => {
        const entries = Array.from({length: count}, (_, index) => ({
            id: `term-${index}`, source: `keyboard-${index}`, target: `键盘-${index}`, caseSensitive: true,
        }));
        Object.assign(runtime.config, {from: 'en', to: 'zh-Hans', glossaryEnabled: true,
            glossaryLibraries: [{id: 'terms', name: 'terms', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans', domains: [], entries}]});
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        const result = await tryTranslateInlineCodeSentence(source, () => ['变量', '不同'], captureFullPageTranslationConfig());
        expect(result).toEqual(allowed ? ['变量', '不同'] : null);
        expect(runtime.requests).toHaveLength(allowed ? 1 : 0);
    });

    it.each(['🚀', '1️⃣', '🇨🇳', '👩🏽‍💻'])('包含受保护 emoji %s 时不试探', async emoji => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const source = `The variable __FRCODE_0123456789abcdef_0__ is different ${emoji}.`;
        expect(await tryTranslateInlineCodeSentence(source, () => ['a', 'b'], captureFullPageTranslationConfig())).toBeNull();
        expect(runtime.requests).toEqual([]);
        expect(runtime.preflight).not.toHaveBeenCalled();
    });

    it('异步语言预检后发现来源过期，不发送试探', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const evidence = deferredBoolean();
        runtime.preflight.mockReturnValueOnce(evidence.promise);
        let current = true;
        const pending = tryTranslateInlineCodeSentence('The variable __FRCODE_0123456789abcdef_0__ is different.',
            () => ['ignored'], captureFullPageTranslationConfig(), undefined, undefined, () => current);
        current = false;
        evidence.resolve(false);
        expect(await pending).toBeNull();
        expect(runtime.requests).toEqual([]);
    });

    it('供应商返回前来源失效时丢弃响应，不解码旧结果', async () => {
        Object.assign(runtime.config, {from: 'en', to: 'zh-Hans'});
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        const decode = vi.fn(() => ['变量', '不同']);
        let current = true;
        runtime.pending = {resolve: () => {}};
        const pending = tryTranslateInlineCodeSentence(source, decode, captureFullPageTranslationConfig(),
            undefined, undefined, () => current);
        await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
        current = false;
        runtime.pending!.resolve();
        expect(await pending).toBeNull();
        expect(decode).not.toHaveBeenCalled();
    });

    it('预检期间取消或 provider 出错时传播错误，不悄悄发回退请求', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const snapshot = captureFullPageTranslationConfig();
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        const controller = new AbortController();
        const evidence = deferredBoolean();
        runtime.preflight.mockReturnValueOnce(evidence.promise);
        const pending = tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot, controller.signal);
        controller.abort();
        evidence.resolve(false);
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(runtime.requests).toEqual([]);
        runtime.fail = 1;
        await expect(tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot)).rejects.toThrow('provider unavailable');
        expect(runtime.requests).toHaveLength(1);
    });

    it.each([
        ['UNTRANSLATED_RESPONSE', 'response'], ['WRONG_LANGUAGE_RESPONSE', 'response'],
        ['TRANSLATION_SLOT_RESPONSE_INVALID', 'response'], ['GLOSSARY_PLACEHOLDER_INVALID', 'unknown'],
    ] as const)('有明确结构化内容错误 %s 时交给既有逐槽路径', async (code, kind) => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        runtime.nextError = new TranslationRequestError({marker: TRANSLATION_ERROR_MARKER, message: 'provider response', kind, retryable: false, code});
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        expect(await tryTranslateInlineCodeSentence(source, () => ['ignored'], captureFullPageTranslationConfig())).toBeNull();
        expect(runtime.requests).toHaveLength(1);
    });

    it.each(['authentication', 'rate-limit', 'network', 'timeout', 'bad-request', 'provider'] as const)(
        '即使携带内容代码，%s 错误也不能被当作可回退的响应异常', async kind => {
            Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
            const error = new TranslationRequestError({marker: TRANSLATION_ERROR_MARKER, message: kind, kind, retryable: false, code: 'UNTRANSLATED_RESPONSE'});
            runtime.nextError = error;
            const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
            await expect(tryTranslateInlineCodeSentence(source, () => ['ignored'], captureFullPageTranslationConfig())).rejects.toBe(error);
        });

    it('未结构化错误及中止不因带内容代码而被忽略', async () => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        const snapshot = captureFullPageTranslationConfig();
        const ordinary = Object.assign(new Error('provider failed'), {code: 'UNTRANSLATED_RESPONSE'});
        runtime.nextError = ordinary;
        await expect(tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot)).rejects.toBe(ordinary);
        const abort = Object.assign(new Error('aborted'), {name: 'AbortError', code: 'GLOSSARY_PLACEHOLDER_INVALID'});
        runtime.nextError = abort;
        await expect(tryTranslateInlineCodeSentence(source, () => ['ignored'], snapshot)).rejects.toBe(abort);
    });

    it('没有错误代码的结构化响应异常原样传播', async () => {
        Object.assign(runtime.config, {from: 'en', to: 'zh-Hans'});
        const error = new TranslationRequestError({marker: TRANSLATION_ERROR_MARKER, message: 'invalid response', kind: 'response', retryable: false});
        runtime.nextError = error;
        const source = 'The variable __FRCODE_0123456789abcdef_0__ is different.';
        await expect(tryTranslateInlineCodeSentence(source, () => ['ignored'], captureFullPageTranslationConfig())).rejects.toBe(error);
        expect(runtime.requests).toHaveLength(1);
    });

    it.each([
        ['ASCII', '', 450, true], ['ASCII', '', 451, false],
        ['多字节', ' early é ', 450, true], ['多字节', ' early é ', 451, false],
    ])('%s %s 标记正文为 %i 字节时按 UTF-8 预算判断', async (_label, unicode, bytes, allowed) => {
        Object.assign(runtime.config, {service: 'freeTranslation', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: [], enableAIContext: false});
        const head = `This English paragraph explains the variable __FRCODE_0123456789abcdef_0__${unicode} and compares the values. `;
        const count = new TextEncoder().encode(head).length;
        const source = head + 'English readable sentence '.repeat(40).slice(0, bytes - count);
        expect(new TextEncoder().encode(source).length).toBe(bytes);
        if (unicode && bytes === 451) expect(source.length).toBeLessThanOrEqual(450);
        const result = await tryTranslateInlineCodeSentence(source, () => ['a', 'b'], captureFullPageTranslationConfig());
        if (allowed) {
            expect(result).toEqual(['a', 'b']);
            expect(runtime.requests).toHaveLength(1);
        } else {
            expect(result).toBeNull();
            expect(runtime.requests).toEqual([]);
            expect(runtime.preflight).not.toHaveBeenCalled();
        }
    });
    it('显式排除快照透传 client，全跳过无需构造结构包', async () => {
        Object.assign(runtime.config, {service: 'openai', to: 'de', excludedLanguages: ['en']});
        const snapshot = captureFullPageTranslationConfig();
        const options = createSnapshotTranslateOptions(snapshot);
        runtime.config.excludedLanguages[0] = 'fr';
        expect(options.excludedLanguages).toEqual(['en']);
        expect(Object.isFrozen(options.excludedLanguages)).toBe(true);
        runtime.preflight.mockResolvedValue(true);
        await expect(translateTextSlots([unknownEnglish], snapshot)).resolves.toEqual([unknownEnglish]);
        expect(runtime.preflight).toHaveBeenCalledWith(unknownEnglish, 'de', ['en'], undefined);
        expect(runtime.requests).toEqual([]);
        runtime.preflight.mockResolvedValue(false);
        await translateTextSlots([unknownEnglish], snapshot);
        expect(runtime.requests[0]?.options.excludedLanguages).toEqual(['en']);
    });

    it('AI 组包前只检测原始槽，异序证据按原索引回填，等待时的输入与配置变化不污染请求', async () => {
        Object.assign(runtime.config, {service: 'openai', from: 'ja', to: 'en', excludedLanguages: ['fr']});
        const first = deferredBoolean(); const second = deferredBoolean();
        runtime.preflight.mockImplementation(text => text === unknownEnglish ? first.promise
            : text === otherUnknownEnglish ? second.promise : Promise.resolve(false));
        const inputs = [unknownEnglish, german, otherUnknownEnglish];
        const snapshot = captureFullPageTranslationConfig();
        const request = translateTextSlots(inputs, snapshot);
        inputs[0] = 'mutated';
        Object.assign(runtime.config, {from: 'de', to: 'zh-Hans', excludedLanguages: ['de']});
        second.resolve(false);
        await Promise.resolve();
        expect(runtime.requests).toEqual([]);
        first.resolve(true);
        await expect(request).resolves.toEqual([unknownEnglish, `T:${german}`, `T:${otherUnknownEnglish}`]);
        expect(runtime.preflight.mock.calls.map(call => call[0])).toEqual([unknownEnglish, otherUnknownEnglish]);
        expect(submitted()).toEqual([german, otherUnknownEnglish]);
        expect(runtime.requests).toHaveLength(1);
        expect(runtime.requests[0]?.options).toMatchObject({skipLanguageDetection: true,
            validateTranslationSlots: true, sourceLanguage: 'ja', targetLanguage: 'en', excludedLanguages: ['fr']});
    });

    it.each([true, false])('等待原槽证据期间取消，迟到 skip=%s 不请求也不登记会话缓存', async skip => {
        Object.assign(runtime.config, {service: 'openai', to: 'en'});
        const work = deferredBoolean();
        runtime.preflight.mockReturnValue(work.promise);
        const controller = new AbortController();
        const session: FullPageTranslationSessionCache = {active: true, translationSlotCache: new Map(),
            ...createFullPageRequestSessionState()};
        const request = translateTextSlots([unknownEnglish, otherUnknownEnglish], captureFullPageTranslationConfig(),
            controller.signal, undefined, session);
        const rejected = expect(request).rejects.toMatchObject({name: 'AbortError'});
        controller.abort();
        work.resolve(skip);
        await rejected;
        expect(runtime.requests).toEqual([]);
        expect(session.translationSlotCache.size).toBe(0);
        expect(session.translationRequestCache?.size ?? 0).toBe(0);
        expect(session.requestControllers?.size).toBe(0);
        expect(session.requestQueueSessions?.size).toBe(0);
        expect(runtime.preflight.mock.calls.every(call => call[3] === controller.signal)).toBe(true);
        clearFullPageTranslationRequestCache(session);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('各请求路径共用逐槽判断', () => {
    it.each(['microsoft', 'google', 'localTranslation', 'freeTranslation'])('%s：截图中文槽零请求，外语槽保持索引', async service => {
        runtime.config.service = service;
        runtime.config.to = 'zh-Hans';
        const texts = [technicalParagraphs[0]!, english, ...technicalParagraphs.slice(1)];
        await expect(translateTextSlots(texts, captureFullPageTranslationConfig()))
            .resolves.toEqual([technicalParagraphs[0], `T:${english}`, ...technicalParagraphs.slice(1)]);
        expect(submitted()).toEqual([english]);
    });
    it.each(['microsoft', 'google', 'freeTranslation', 'localTranslation'])('%s：真实 DOM 中独立 X 日期不进入相邻正文的请求槽', async service => {
        runtime.config.service = service;
        runtime.config.to = 'zh-Hans';
        const {document} = parseHTML(`<html><body><p>${english}<a href="/status/123">10月7日</a><span>3:19 · 2026年10月8日</span></p></body></html>`);
        const owner = document.querySelector<HTMLElement>('p')!;
        const dateNodes = Array.from(owner.querySelectorAll('a,span')).map(element => ({element, source:element.firstChild, value:element.textContent}));
        const slots = collectLiveTranslationTextSlots(owner);
        expect(slots.map(slot => slot.source)).toEqual([english]);
        expect(extractTranslationText(owner)).toBe(english);
        await expect(translateTextSlots(slots.map(slot => slot.source), captureFullPageTranslationConfig()))
            .resolves.toEqual([`T:${english}`]);
        expect(submitted()).toEqual([english]);
        dateNodes.forEach(({element, source, value}) => {
            expect(element.firstChild).toBe(source);
            expect(element.textContent).toBe(value);
        });
    });

    it('中文 README 中的英文名称不触发请求，旁边独立的英文段落照常翻译', async () => {
        runtime.config.to = 'zh-Hans';
        const source = 'FluentRead 支持在原网页中对照阅读原文与译文，并提供划词翻译、AI 阅读辅助、图片翻译、文档翻译和视频双语字幕。翻译卡片接入了 DeepSeek Harness 会话内核的浏览器适配，支持结合上下文解释选中文字并连续追问。';
        const result = await translateTextSlots([source, english], captureFullPageTranslationConfig());
        expect(result).toEqual([source, `T:${english}`]);
        expect(submitted()).toEqual([english]);
    });

    it.each([
        ['microsoft', 'batch'],
        ['freeTranslation', 'batch'],
        ['google', 'batch'],
        ['localTranslation', 'text'],
    ] as const)('%s 只提交判断为需要翻译的槽并按原索引回填', async (service, kind) => {
        runtime.config.service = service;
        const snapshot = captureFullPageTranslationConfig();
        // 空槽保持既有协议：不做语言判断，照常占位提交，由供应商回传空译文。
        const expectedSubmitted = origins.filter(origin => !origin.trim() || !shouldSkipTranslationForTarget(origin, 'de'));
        expect(expectedSubmitted).toEqual([english, japanese, shortGermanLink, chinese, '84522b3', '']);

        const result = await translateTextSlots(origins, snapshot);
        expect(submitted().sort()).toEqual([...expectedSubmitted].sort());
        expect(runtime.requests.every(request => request.kind === kind)).toBe(true);
        expect(result).toEqual(origins.map(origin => expectedSubmitted.includes(origin) ? `T:${origin}` : origin));
    });

    it.each(['freeTranslation', 'google'])('%s 活跃全文会话复用逐槽缓存时仍先过滤同目标槽', async service => {
        runtime.config.service = service;
        const snapshot = captureFullPageTranslationConfig();
        const session = {active: true, translationSlotCache: new Map(), translationRequestCache: new Map(),
            requestSignal: new AbortController().signal, requestControllers: new Set<AbortController>(), requestQueueSessions: new Set()};
        await translateTextSlots([german, english], snapshot, undefined, undefined, session as never);
        await translateTextSlots([german, english], snapshot, undefined, undefined, session as never);
        expect(submitted()).toEqual([english]);
        clearFullPageTranslationRequestCache(session);
    });

    it('AI 跨候选合并批次只包含外语槽，多个候选各自回填', async () => {
        Object.assign(runtime.config, {service: 'openai', enableAIMultiSegment: true});
        const snapshot = captureFullPageTranslationConfig();
        const session = {active: true, translationSlotCache: new Map(), allowAIMultiSegment: true};
        const [first, second] = await Promise.all([
            translateTextSlots([german, english], snapshot, undefined, undefined, session as never),
            translateTextSlots([japanese, german], snapshot, undefined, undefined, session as never),
        ]);
        expect(first).toEqual([german, `T:${english}`]);
        expect(second).toEqual([`T:${japanese}`, german]);
        expect(submitted().sort()).toEqual([english, japanese].sort());
        expect(runtime.requests.some(request => request.options.aiMultiSegment === true)).toBe(true);
    });

    it('三美元公式源码留在本地，两侧正文分别按同一规则判断', async () => {
        const snapshot = captureFullPageTranslationConfig();
        const result = await translateTextSlots([`${german} $$$x^2$$$ ${english}`], snapshot);
        expect(submitted()).toEqual([english]);
        expect(result).toEqual([`${german} $$$x^2$$$ T:${english}`]);
    });

    it('全部槽都是目标语言、排除语言或无字母内容时不发请求', async () => {
        runtime.config.excludedLanguages = ['ja', 'zh-Hans'];
        const snapshot = captureFullPageTranslationConfig();
        await expect(translateTextSlots([german, japanese, chinese, '2026-09-16'], snapshot)).resolves.toEqual([german, japanese, chinese, '2026-09-16']);
        expect(runtime.requests).toEqual([]);
    });
});

describe('X 实际中文界面标签的全文请求边界', () => {
    // 来自 X 全文 provider origins；只替换客户端与配置，沿用真实语言核心。
    const labels = ['登录或注册 X', '使用用户名或邮箱登录', '相关用户', '关注', '当前趋势', '条款', '隐私'];
    const services = ['google', 'microsoft', 'freeTranslation', 'localTranslation'];

    it.each(services)('%s：auto → zh-Hans 保留七个中文标签，只提交相邻英文正文', async service => {
        Object.assign(runtime.config, {service, from: 'auto', to: 'zh-Hans'});
        const texts = [labels[0]!, english, ...labels.slice(1)];
        const result = await translateTextSlots(texts, captureFullPageTranslationConfig());
        expect.soft(submitted()).toEqual([english]);
        expect(result).toEqual([labels[0], `T:${english}`, ...labels.slice(1)]);
    });

    it.each(services)('%s：auto → en 仍提交七个中文标签，保留相邻英文正文', async service => {
        Object.assign(runtime.config, {service, from: 'auto', to: 'en'});
        const result = await translateTextSlots([labels[0]!, english, ...labels.slice(1)], captureFullPageTranslationConfig());
        expect(submitted()).toEqual(labels);
        expect(result).toEqual([`T:${labels[0]}`, english, ...labels.slice(1).map(label => `T:${label}`)]);
    });

    it.each(services)('%s：简繁转换继续请求，混合正文、日韩文与不确定纯 Han 不误跳过', async service => {
        Object.assign(runtime.config, {service, from: 'auto', to: 'zh-Hant'});
        // 七个完整标签含简体字形；同形片段「注册」不单独证明任意纯 Han 属于中文。
        const traditional = '這個網頁可以翻譯繁體中文。';
        const hantResult = await translateTextSlots([...labels, traditional], captureFullPageTranslationConfig());
        expect.soft(submitted()).toEqual(labels);
        expect.soft(hantResult).toEqual([...labels.map(text => `T:${text}`), traditional]);

        runtime.requests = [];
        runtime.config.to = 'zh-Hans';
        const foreignOrUncertain = [
            traditional,
            '这些算法使用 AI，可以降低成本，但是 Please translate this sentence.',
            'この機能は誰でも簡単に使うことが出来ます。',
            '경제(經濟) 성장률이 올해 크게 높아졌습니다.',
            '時間',
            '日本国立大学',
            '趨勢',
        ];
        const hansResult = await translateTextSlots(foreignOrUncertain, captureFullPageTranslationConfig());
        expect(submitted()).toEqual(foreignOrUncertain);
        expect(hansResult).toEqual(foreignOrUncertain.map(text => `T:${text}`));

        runtime.requests = [];
        runtime.config.to = 'zh-Hant';
        await expect(translateTextSlots(['趨勢'], captureFullPageTranslationConfig())).resolves.toEqual(['T:趨勢']);
        expect(submitted()).toEqual(['趨勢']);

        runtime.requests = [];
        Object.assign(runtime.config, {to: 'en', excludedLanguages: ['zh-Hant']});
        await expect(translateTextSlots(['趨勢'], captureFullPageTranslationConfig())).resolves.toEqual(['T:趨勢']);
        expect(submitted()).toEqual(['趨勢']);
    });
});

describe('排除语言与快照变化', () => {
    it('是否配置排除语言都执行同样的完整识别：德文目标下德文槽不因排除列表为空而提交', async () => {
        const withoutExcluded = captureFullPageTranslationConfig();
        runtime.config.excludedLanguages = ['fr'];
        const withExcluded = captureFullPageTranslationConfig();
        await translateTextSlots([german, english], withoutExcluded);
        await translateTextSlots([german, english], withExcluded);
        expect(submitted()).toEqual([english, english]);
    });

    it('目标语言相同的文本作为排除语言时得到相同的逐槽结论', async () => {
        const asTarget = captureFullPageTranslationConfig();
        Object.assign(runtime.config, {to: 'zh-Hant', excludedLanguages: ['de']});
        const asExcluded = captureFullPageTranslationConfig();
        const first = await translateTextSlots([german, english], asTarget);
        const second = await translateTextSlots([german, english], asExcluded);
        expect(first[0]).toBe(german);
        expect(second[0]).toBe(german);
        expect(submitted()).toEqual([english, english]);
    });

    it('同一会话切换目标语言或清空排除列表后重新判断，不复用旧的保留或译文结果', async () => {
        const session = {active: true, translationSlotCache: new Map(), translationRequestCache: new Map(),
            requestSignal: new AbortController().signal};
        const germanTarget = captureFullPageTranslationConfig();
        await translateTextSlots([german, english], germanTarget, undefined, undefined, session as never);
        const englishTarget = {...germanTarget, targetLanguage: 'en'};
        await expect(translateTextSlots([german, english], englishTarget, undefined, undefined, session as never))
            .resolves.toEqual([`T:${german}`, english]);
        const excludedGerman = {...englishTarget, targetLanguage: 'zh-Hans', excludedLanguages: Object.freeze(['de'])};
        await expect(translateTextSlots([german, english], excludedGerman, undefined, undefined, session as never))
            .resolves.toEqual([german, `T:${english}`]);
        const cleared = {...excludedGerman, excludedLanguages: Object.freeze([])};
        await expect(translateTextSlots([german, english], cleared, undefined, undefined, session as never))
            .resolves.toEqual([`T:${german}`, `T:${english}`]);
        expect(submitted()).toEqual([english, german, english, german, english]);
        clearFullPageTranslationRequestCache(session);
    });
});

describe('同次批译复制快照的 slot key 复用', () => {
    it.each([
        {name: '100 个不同原文', repeated: false, settled: 0},
        {name: '100 个输入中的 50 个重复原文', repeated: true, settled: 0},
        {name: '100 个输入中的 50 个已结算缓存命中', repeated: false, settled: 50},
    ])('$name 只序列化每个输入一次，缓存身份和原索引回填保持一致', async ({repeated, settled}) => {
        runtime.config.to = 'zh-Hans';
        const snapshot = captureFullPageTranslationConfig({glossaryIds: ['fixture-glossary']});
        const distinct = Array.from({length: 100}, (_, index) => `${english} Paragraph ${index}.`);
        const inputs = repeated ? distinct.slice(0, 50).flatMap(origin => [origin, origin]) : distinct;
        const session: FullPageTranslationSessionCache = {
            active: true, translationSlotCache: new Map(), ...createFullPageRequestSessionState(),
            allowNativeBatch: false,
        };
        const serialize = JSON.stringify;
        const slotKeys: string[] = [];
        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
            const key = serialize(value, replacer, space);
            // 观察生产模块实际构造的逐槽键；不在测试中重写缓存键算法。
            if (value && typeof value === 'object' && 'origin' in value
                && 'glossaryRevision' in value && 'excludedLanguages' in value) slotKeys.push(key);
            return key;
        });
        try {
            if (settled) {
                await expect(translateTextSlots(distinct.slice(0, settled), snapshot, undefined, undefined, session))
                    .resolves.toEqual(distinct.slice(0, settled).map(origin => `T:${origin}`));
                expect(new Set(slotKeys).size).toBe(settled);
                expect([...session.translationSlotCache.values()].every(entry => entry.settled)).toBe(true);
            }
            const cachedKeys = [...session.translationSlotCache.keys()];
            slotKeys.length = 0;
            runtime.requests = [];

            await expect(translateTextSlots(inputs, snapshot, undefined, undefined, session))
                .resolves.toEqual(inputs.map(origin => `T:${origin}`));
            expect(slotKeys).toHaveLength(100);
            expect(slotKeys.map(key => JSON.parse(key).origin)).toEqual(inputs);
            expect([...session.translationSlotCache.keys()]).toEqual([...new Set([...cachedKeys, ...slotKeys])]);
            expect(submitted()).toEqual(distinct.slice(settled, repeated ? 50 : 100));
            expect(runtime.requests).toHaveLength(1);
            expect(runtime.requests[0]?.kind).toBe('batch');
            for (const [key, entry] of session.translationSlotCache) {
                const identity = JSON.parse(key);
                expect(identity).toMatchObject({service: 'microsoft', model: 'default', thinking: false,
                    from: 'auto', to: 'zh-Hans', glossaryIds: ['fixture-glossary'], excludedLanguages: [],
                    enableAIContext: false});
                expect(entry.settled).toBe(true);
                await expect(entry.promise).resolves.toBe(`T:${identity.origin}`);
            }
        } finally {
            stringify.mockRestore();
            clearFullPageTranslationRequestCache(session);
        }
    });
});

describe('取消与失败重试', () => {
    it('调用方取消只影响外语槽请求，已判断为同目标的槽不会被提交', async () => {
        runtime.config.service = 'google';
        runtime.pending = {resolve: () => undefined};
        const controller = new AbortController();
        const snapshot = captureFullPageTranslationConfig();
        const request = translateTextSlots([german, english], snapshot, controller.signal);
        await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
        controller.abort();
        runtime.pending?.resolve();
        await request.catch(() => undefined);
        expect(submitted()).toEqual([english]);
    });

    it('失败后强制重试仍只请求外语槽，并在成功后回填', async () => {
        const session = {active: true, translationSlotCache: new Map(), translationRequestCache: new Map(),
            requestSignal: new AbortController().signal};
        runtime.fail = 1;
        const snapshot = captureFullPageTranslationConfig();
        await expect(translateTextSlots([german, english], snapshot, undefined, undefined, session as never)).rejects.toThrow('provider unavailable');
        await expect(translateTextSlots([german, english], snapshot, undefined, undefined, session as never, true))
            .resolves.toEqual([german, `T:${english}`]);
        expect(submitted()).toEqual([english, english]);
        clearFullPageTranslationRequestCache(session);
    });
});

describe('协议辅助', () => {
    it('测试解析器能还原文本包中的槽，保证提交检查覆盖普通供应商路径', () => {
        const packet = serializeTranslationSlots(['a', 'b'], 'nonce');
        runtime.requests = [{kind: 'text', origins: [packet.payload], options: {}}];
        expect(submitted()).toEqual(['a', 'b']);
    });
});

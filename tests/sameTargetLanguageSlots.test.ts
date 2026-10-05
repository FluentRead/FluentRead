/**
 * @file tests/sameTargetLanguageSlots.test.ts
 * 全文富文本槽与批量请求在真实语言识别下的一致性：谷歌/微软批量、免费聚合会话缓存、普通供应商文本包、本地模型逐槽、
 * AI 跨候选合并与 $$$ 公式拆分都只提交未被同一判断跳过的槽，并按原索引回填；是否配置排除语言不改变识别深度；
 * 快照切换目标或排除语言后重新判断，不复用旧会话结果；取消与失败重试同样只涉及外语槽。只替换翻译客户端与配置存储。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import technicalParagraphs from './fixtures/chinese-technical-paragraphs.json';

const runtime = vi.hoisted(() => ({
    requests: [] as Array<{kind: 'text' | 'batch'; origins: string[]; options: Record<string, unknown>}>,
    fail: 0,
    pending: null as null | {resolve: () => void},
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
vi.mock('@/src/app/translation/client', () => ({
    translateText: async (origin: string, _context: string, options: Record<string, unknown>) =>
        (await respond('text', [origin], options))[0],
    translateTextBatch: (origins: readonly string[], _context: string, options: Record<string, unknown>) =>
        respond('batch', [...origins], options),
}));

import {
    captureFullPageTranslationConfig,
    clearFullPageTranslationRequestCache,
    translateTextSlots,
} from '@/src/features/full-page-translation/content/translationRequest';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {serializeTranslationSlots} from '@/src/core/translation/public';

const german = 'Dieser deutsche Absatz beschreibt die verschiedenen Einstellungen der Anwendung und die automatische Übersetzung.';
const english = 'This English sentence still needs a German translation for the reader.';
const japanese = 'GPT-6 Sol の新しいモデルを発表しました。';
const chinese = '云端模型清单允许清空，且不再连带拒掉无关偏好的保存 (84522b3)';
const shortGermanLink = 'Mehr';
const origins = [german, english, japanese, shortGermanLink, chinese, '84522b3', ''];

function submitted(): string[] {
    return runtime.requests.flatMap(request => request.origins.flatMap(origin => origin.startsWith('___FLUENTREAD_')
        ? [...origin.matchAll(/___FLUENTREAD_[^_]+_\d+_BEGIN___([\s\S]*?)___FLUENTREAD_[^_]+_\d+_END___/gu)].map(match => match[1]!)
        : [origin]));
}

beforeEach(() => {
    vi.stubGlobal('document', {title: 'Release notes', location: {href: 'https://example.test/releases'}, URL: 'https://example.test/releases'});
    runtime.requests = [];
    runtime.fail = 0;
    runtime.pending = null;
    Object.assign(runtime.config, {service: 'microsoft', from: 'auto', to: 'de', excludedLanguages: [], enableAIMultiSegment: false});
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

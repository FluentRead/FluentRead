import {beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({
    slots: [] as Array<{node: Text; prefix: string; source: string; suffix: string}>,
    translations: [] as string[],
    translateTextSlots: vi.fn(),
    getCurrentTranslationCore: vi.fn(() => ({shouldStayOriginal: () => false})),
}));

vi.mock('@/src/core/translation/public', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/src/core/translation/public')>();
    return {
        collectLiveTranslationTextSlots: () => runtime.slots,
        getCurrentTranslationCore: runtime.getCurrentTranslationCore,
        // 属性型按钮标签的安全边界由 core 唯一定义，测试不复制其判定规则。
        getTranslatableControlValueAttribute: actual.getTranslatableControlValueAttribute,
        normalizeTranslationText: actual.normalizeTranslationText,
        // 整块请求的骨架判定只由 core 定义，这里直接复用真实实现。
        createTranslationSourceSnapshot: actual.createTranslationSourceSnapshot,
        buildWholeBlockTranslationSource: actual.buildWholeBlockTranslationSource,
    };
});

vi.mock('@/src/features/full-page-translation/content/translationRequest', () => ({
    translateTextSlots: runtime.translateTextSlots,
}));

import {parseHTML} from 'linkedom';
import {createTranslationRequest, translateControlValue, translateLiveText} from '@/src/features/full-page-translation/content/liveTextTranslation';
// 真实槽位收集器绕过上方对 public 的替身，让请求槽与 DOM 骨架保持一致。
import {collectLiveTranslationTextSlots as collectRealSlots} from '@/src/core/translation/serialization';

const snapshot = {service: 'microsoft', model: 'default', thinking: false, sourceLanguage: 'en', targetLanguage: 'zh',
    useCache: true, enableAIContext: false, enableAIMultiSegment: false, enableNativeBatch: true, displayMode: 'single' as const, style: 0};

describe('实时文本翻译快照', () => {
    beforeEach(() => {
        runtime.slots = [];
        runtime.translations = [];
        runtime.translateTextSlots.mockReset();
        runtime.translateTextSlots.mockImplementation(async () => runtime.translations);
    });

    it('正文双语请求只提交可译文本槽，空内容不调用服务', async () => {
        const {document} = parseHTML('<html><body><p>Source text</p></body></html>');
        const owner = document.querySelector('p')!;
        expect(await createTranslationRequest(owner, 'content', 'bilingual', snapshot)).toEqual({kind: 'snapshot', sources: [], translations: []});
        expect(runtime.translateTextSlots).not.toHaveBeenCalled();
        runtime.slots = [{node: owner.firstChild as Text, prefix: '', source: 'Source text', suffix: ''}];
        runtime.translations = ['来源文字'];
        const result = await createTranslationRequest(owner, 'content', 'bilingual', snapshot, undefined, undefined, undefined, undefined, true, 'all');
        expect(result).toEqual({kind: 'snapshot', sources: ['Source text'], translations: ['来源文字']});
        expect(runtime.getCurrentTranslationCore).toHaveBeenLastCalledWith('all');
        expect(runtime.translateTextSlots).toHaveBeenLastCalledWith(['Source text'], snapshot, undefined, undefined, undefined, true);
        expect(owner.textContent).toBe('Source text');
    });

    it.each([{kind: 'content', mode: 'single'}, {kind: 'control', mode: 'bilingual'}] as const)(
        '$kind / $mode 请求返回原位 Text 槽并保留 all 范围', async ({kind, mode}) => {
            const {document} = parseHTML('<html><body><button>Execute</button></body></html>');
            const owner = document.querySelector('button')!;
            runtime.slots = [{node: owner.firstChild as Text, prefix: '', source: 'Execute', suffix: ''}];
            runtime.translations = ['执行'];
            const result = await createTranslationRequest(owner, kind, mode, snapshot, undefined, undefined, undefined, undefined, false, 'all');
            expect(result).toMatchObject({kind: 'live-text', changed: true, sources: ['Execute'], translations: ['执行']});
            expect(runtime.getCurrentTranslationCore).toHaveBeenLastCalledWith('all');
            expect(owner.textContent).toBe('Execute');
        },
    );

    it('按钮型 input 走属性替换请求，不再尝试寻找不存在的文本槽', async () => {
        const {document} = parseHTML('<html><body><input type="button" value="Preview changes"></body></html>');
        const owner = document.querySelector<HTMLElement>('input')!;
        runtime.translations = ['预览更改'];

        const result = await createTranslationRequest(owner, 'control', 'bilingual', snapshot);
        expect(result).toEqual({
            kind: 'control-value', attribute: 'value', complete: true, changed: true,
            sources: ['Preview changes'], translations: ['预览更改'], text: '预览更改',
        });
        expect(runtime.translateTextSlots).toHaveBeenLastCalledWith(
            ['Preview changes'], snapshot, undefined, undefined, undefined, false);
        // 请求阶段绝不改写宿主属性，写入由渲染层在提交时完成。
        expect(owner.getAttribute('value')).toBe('Preview changes');
    });

    it('按钮标签缺失或译文与原文相同时结果标记为未完成或无变化', async () => {
        const {document} = parseHTML('<html><body><input id="a" type="button" value="Preview changes">' +
            '<input id="b" type="button"></body></html>');
        const labelled = document.querySelector<HTMLElement>('#a')!;
        const missing = document.querySelector<HTMLElement>('#b')!;

        runtime.translations = ['Preview changes'];
        expect(await translateControlValue(labelled, 'value', snapshot))
            .toMatchObject({complete: true, changed: false, text: 'Preview changes'});

        runtime.translations = [];
        expect(await translateControlValue(missing, 'value', snapshot))
            .toMatchObject({complete: false, changed: false, sources: [''], text: ''});
    });

    it('空槽位返回未完成的空结果', async () => {
        const {document} = parseHTML('<html><body></body></html>');
        const result = await translateLiveText(document.body, snapshot);
        expect(result).toMatchObject({kind: 'live-text', complete: false, changed: false, sources: [], translations: []});
        expect(result.nodes).toEqual([]);
        expect(result.slots).toEqual([]);
        expect(runtime.translateTextSlots).not.toHaveBeenCalled();
    });

    it('保留槽位前后缀，并区分 unchanged、changed 与不完整响应', async () => {
        const {document} = parseHTML('<html><body></body></html>');
        const node = document.createTextNode('source');
        runtime.slots = [{node, prefix: '[', source: 'source', suffix: ']'}];

        runtime.translations = ['source'];
        const unchanged = await translateLiveText(document.body, snapshot);
        expect(unchanged).toMatchObject({complete: true, changed: false, sources: ['source'], translations: ['source']});
        expect(unchanged.slots[0]?.text).toBe('[source]');

        runtime.translations = ['译文'];
        const changed = await translateLiveText(document.body, snapshot);
        expect(changed).toMatchObject({complete: true, changed: true, sources: ['source'], translations: ['译文']});
        expect(changed.slots[0]?.text).toBe('[译文]');

        runtime.translations = [];
        const incomplete = await translateLiveText(document.body, snapshot);
        expect(incomplete.complete).toBe(false);
        expect(incomplete.slots[0]?.text).toBe('[source]');

        runtime.slots = [{node, prefix: '', source: '', suffix: ''}];
        runtime.translations = ['译文'];
        expect((await translateLiveText(document.body, snapshot)).changed).toBe(true);
    });
});

describe('双语正文整块翻译', () => {
    const bilingual = {...snapshot, displayMode: 'bilingual' as const};
    beforeEach(() => {
        runtime.slots = [];
        runtime.translations = [];
        runtime.translateTextSlots.mockReset();
        runtime.translateTextSlots.mockImplementation(async () => runtime.translations);
    });
    const owner = (html: string) => {
        const {document} = parseHTML(`<html><body>${html}</body></html>`);
        const element = document.body.firstElementChild as HTMLElement;
        runtime.slots = collectRealSlots(element);
        return element;
    };
    const paragraph = () => owner('<p id="t">Read <a href="/g">the guide</a>.</p>');

    it('多槽候选整块请求，整段译文只回填首个槽位', async () => {
        const target = paragraph();
        runtime.translateTextSlots.mockImplementation(async () => ['读完这份指南。']);

        const result = await createTranslationRequest(target, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenCalledTimes(1);
        expect(runtime.translateTextSlots).toHaveBeenCalledWith(
            ['Read the guide.'], bilingual, undefined, undefined, undefined, false);
        expect(result).toEqual({
            kind: 'snapshot',
            sources: ['Read', 'the guide', '.'],
            translations: ['读完这份指南。', '', ''],
        });
    });

    it('整块请求没有有效译文时回退逐槽请求', async () => {
        for (const empty of [[], [''], [' \u00a0']]) {
            const target = paragraph();
            runtime.translateTextSlots.mockReset();
            runtime.translateTextSlots
                .mockImplementationOnce(async () => empty)
                .mockImplementation(async () => runtime.translations);
            runtime.translations = ['译:Read', '译:the guide', '译:.'];

            const result = await createTranslationRequest(target, 'content', 'bilingual', bilingual);
            expect(runtime.translateTextSlots).toHaveBeenNthCalledWith(2,
                ['Read', 'the guide', '.'], bilingual, undefined, undefined, undefined, false);
            expect(result).toEqual({
                kind: 'snapshot',
                sources: ['Read', 'the guide', '.'],
                translations: ['译:Read', '译:the guide', '译:.'],
            });
        }
    });

    it('整块请求等待后回退逐槽仍沿用入口配置，外部修改不切换语言、模型或术语', async () => {
        const target = paragraph();
        const ids = ['library-a'];
        const excluded = ['de'];
        const mutable = {...bilingual, model: 'original-model', glossaryIds: ids, excludedLanguages: excluded};
        const options: unknown[] = [];
        runtime.translateTextSlots
            .mockImplementationOnce(async (_origins, requestSnapshot) => {
                options.push({...requestSnapshot, glossaryIds: [...requestSnapshot.glossaryIds], excludedLanguages: [...requestSnapshot.excludedLanguages]});
                mutable.targetLanguage = 'ja';
                mutable.model = 'edited-model';
                ids.push('library-b');
                excluded.push('fr');
                await Promise.resolve();
                return [];
            })
            .mockImplementationOnce(async (_origins, requestSnapshot) => {
                options.push(requestSnapshot);
                return ['译:Read', '译:the guide', '译:.'];
            });
        const result = await createTranslationRequest(target, 'content', 'bilingual', mutable);
        expect(result).toMatchObject({translations: ['译:Read', '译:the guide', '译:.']});
        expect(options).toHaveLength(2);
        for (const option of options) expect(option).toMatchObject({targetLanguage: 'zh', model: 'original-model',
            glossaryIds: ['library-a'], excludedLanguages: ['de']});
    });

    it('整块译文与原文一致时按未变化上报，不再逐槽请求', async () => {
        const target = paragraph();
        runtime.translateTextSlots.mockImplementation(async () => ['Read the guide.']);

        const result = await createTranslationRequest(target, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            kind: 'snapshot',
            sources: ['Read', 'the guide', '.'],
            translations: ['Read', 'the guide', '.'],
        });
    });

    it('含行内代码等无法拍平内容的段落直接逐槽请求，不发整块请求', async () => {
        const target = owner('<p>Use <code>fetch</code> to <b>load</b> data</p>');
        runtime.translations = ['译:Use', '译:to', '译:load', '译:data'];

        const result = await createTranslationRequest(target, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenCalledTimes(1);
        expect(runtime.translateTextSlots).toHaveBeenCalledWith(
            ['Use', 'to', 'load', 'data'], bilingual, undefined, undefined, undefined, false);
        expect(result).toMatchObject({translations: ['译:Use', '译:to', '译:load', '译:data']});
    });

    it('请求槽与渲染骨架不一致时放弃整块请求', async () => {
        const target = paragraph();
        runtime.slots = runtime.slots.slice(0, 2);
        runtime.translations = ['译:Read', '译:the guide'];

        await createTranslationRequest(target, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenCalledTimes(1);
        expect(runtime.translateTextSlots).toHaveBeenCalledWith(
            ['Read', 'the guide'], bilingual, undefined, undefined, undefined, false);
    });

    it('宿主保留换行时整段原文保留文本换行，样式读取失败时按普通空白处理', async () => {
        const html = '<p>one\n<a href="/x">two</a></p>';
        const request = async (getComputedStyle: (() => {whiteSpace: string}) | null) => {
            const target = owner(html);
            Object.defineProperty(target.ownerDocument, 'defaultView', {configurable: true,
                value: getComputedStyle ? {getComputedStyle} : null});
            runtime.translateTextSlots.mockReset();
            runtime.translateTextSlots.mockImplementation(async () => ['一二']);
            await createTranslationRequest(target, 'content', 'bilingual', bilingual);
            return runtime.translateTextSlots.mock.calls[0]?.[0];
        };

        expect(await request(() => ({whiteSpace: 'pre-wrap'}))).toEqual(['one\ntwo']);
        expect(await request(() => ({whiteSpace: 'normal'}))).toEqual(['one two']);
        expect(await request(null)).toEqual(['one two']);
        expect(await request(() => {
            throw new Error('detached');
        })).toEqual(['one two']);
    });
});


describe('目标语言排版回显保持网页原文', () => {
    it.each(['single', 'bilingual'] as const)('%s 模式不把仅改变句尾标点的同语言结果显示为翻译', async mode => {
        const {document} = parseHTML('<html><body><p>我们已经完成文档翻译。</p></body></html>');
        const owner = document.querySelector('p')!;
        const source = owner.textContent!;
        runtime.slots = [{node: owner.firstChild as Text, prefix: '', source, suffix: ''}];
        runtime.translations = ['我们已经完成文档翻译'];
        runtime.translateTextSlots.mockImplementation(async () => runtime.translations);
        const active = {...snapshot, sourceLanguage: 'auto', targetLanguage: 'zh-Hans', displayMode: mode};
        const result = await createTranslationRequest(owner, 'content', mode, active);
        if (result.kind === 'live-text') expect(result.changed).toBe(false);
        expect(owner.textContent).toBe(source);
    });
});

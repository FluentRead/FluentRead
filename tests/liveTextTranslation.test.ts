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
    };
});

vi.mock('@/src/features/full-page-translation/content/translationRequest', () => ({
    translateTextSlots: runtime.translateTextSlots,
}));

import {parseHTML} from 'linkedom';
import {createTranslationRequest, buildWholeBlockSourceText, translateControlValue, translateLiveText} from '@/src/features/full-page-translation/content/liveTextTranslation';
// 真实槽位收集器绕过上方对 public 的替身，用于直接验证整块来源文本的 DOM 边界规则。
import {collectLiveTranslationTextSlots as collectRealSlots} from '@/src/core/translation/serialization';

const snapshot = {service: 'microsoft', model: 'default', thinking: false, sourceLanguage: 'en', targetLanguage: 'zh',
    useCache: true, enableAIContext: false, enableAIMultiSegment: false, displayMode: 'single' as const, style: 0};

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
    const paragraph = () => {
        const {document} = parseHTML('<html><body><p id="t">Read <a href="/g">the guide</a>.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#t')!;
        const link = owner.querySelector('a')!;
        return {
            owner,
            slots: [
                {node: owner.firstChild as Text, prefix: '', source: 'Read', suffix: ' '},
                {node: link.firstChild as Text, prefix: '', source: 'the guide', suffix: ''},
                {node: owner.lastChild as Text, prefix: '', source: '.', suffix: ''},
            ],
        };
    };

    it('多槽候选整块请求，整段译文只回填首个槽位', async () => {
        const {owner, slots} = paragraph();
        runtime.slots = slots;
        runtime.translateTextSlots.mockImplementation(async () => ['读完这份指南。']);

        const result = await createTranslationRequest(owner, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenCalledTimes(1);
        expect(runtime.translateTextSlots).toHaveBeenCalledWith(
            ['Read the guide.'], bilingual, undefined, undefined, undefined, false);
        expect(result).toEqual({
            kind: 'snapshot',
            sources: ['Read', 'the guide', '.'],
            translations: ['读完这份指南。', '', ''],
        });
    });

    it('整块请求没有译文时回退逐槽请求', async () => {
        const {owner, slots} = paragraph();
        runtime.slots = slots;
        runtime.translateTextSlots
            .mockImplementationOnce(async () => [''])
            .mockImplementation(async () => runtime.translations);
        runtime.translations = ['译:Read', '译:the guide', '译:.'];

        const result = await createTranslationRequest(owner, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenNthCalledWith(2,
            ['Read', 'the guide', '.'], bilingual, undefined, undefined, undefined, false);
        expect(result).toEqual({
            kind: 'snapshot',
            sources: ['Read', 'the guide', '.'],
            translations: ['译:Read', '译:the guide', '译:.'],
        });
    });

    it('整块译文与原文一致时按未变化上报，不再逐槽请求', async () => {
        const {owner, slots} = paragraph();
        runtime.slots = slots;
        runtime.translateTextSlots.mockImplementation(async () => ['Read the guide.']);

        const result = await createTranslationRequest(owner, 'content', 'bilingual', bilingual);
        expect(runtime.translateTextSlots).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            kind: 'snapshot',
            sources: ['Read', 'the guide', '.'],
            translations: ['Read', 'the guide', '.'],
        });
    });
});

describe('整块来源文本拼接', () => {
    const source = (html: string) => {
        const {document} = parseHTML(`<html><body>${html}</body></html>`);
        const root = document.body.firstElementChild as HTMLElement;
        return buildWholeBlockSourceText(root, collectRealSlots(root));
    };

    it('内联格式无缝拼接，替换元素与换行保留词边界', () => {
        expect(source('<p><b>one</b><i>two</i></p>')).toBe('onetwo');
        expect(source('<p>Hello <b>world</b>!</p>')).toBe('Hello world!');
        expect(source('<p>one<br>two</p>')).toBe('one\ntwo');
        expect(source('<p>one<img src="a.png">s</p>')).toBe('one s');
    });

    it('受保护文本、相邻空白与换行边界不重复分隔', () => {
        expect(source('<p>one<span translate="no">X</span>s</p>')).toBe('one s');
        expect(source('<p>one<span translate="no">X</span> two</p>')).toBe('one two');
        expect(source('<p>one <span translate="no">X</span> two</p>')).toBe('one  two');
        expect(source('<p>one\n<br>two</p>')).toBe('one\ntwo');
        expect(source('<p>one<br>\ntwo</p>')).toBe('one\ntwo');
        expect(source('<p>one<br><img src="a.png">two</p>')).toBe('one\ntwo');
    });

    it('首个槽位之前的换行或分隔不产生前导空白', () => {
        expect(source('<p><br>two</p>')).toBe('two');
        expect(source('<p><span translate="no">X</span>two</p>')).toBe('two');
    });
});

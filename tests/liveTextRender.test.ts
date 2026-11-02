import {parseHTML} from 'linkedom';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({
    slots: null as null | (() => Array<{node: Text; prefix: string; source: string; suffix: string}>),
}));

// 该 DOM 单元测试不启动扩展后台；保留真实默认配置，避免尝试读取不存在的浏览器存储。
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    return {config: new Config()};
});

vi.mock('@/src/core/translation/public', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/src/core/translation/public')>();
    return {
        ...actual,
        collectLiveTranslationTextSlots: (
            node: HTMLElement,
            ...rest: Parameters<typeof actual.collectLiveTranslationTextSlots> extends [unknown, ...infer R] ? R : never[]
        ) => runtime.slots ? runtime.slots() : actual.collectLiveTranslationTextSlots(node, ...rest),
    };
});

import {renderLiveTextResult} from '@/src/features/full-page-translation/content/liveTextRender';
import type {
    ControlValueTranslationResult,
    LiveTextTranslationResult,
} from '@/src/features/full-page-translation/content/liveTextTranslation';
import {
    beginTranslation,
    getTranslationState,
    restoreTranslation,
    setSpinner,
} from '@/src/features/full-page-translation/content/state';

function page(html: string) {
    const {document, window} = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    return document;
}

function liveResult(overrides: Partial<LiveTextTranslationResult> = {}): LiveTextTranslationResult {
    return {
        kind: 'live-text',
        complete: true,
        changed: true,
        sources: [],
        translations: [],
        nodes: [],
        slots: [],
        ...overrides,
    };
}

function controlValueResult(
    overrides: Partial<ControlValueTranslationResult> = {},
): ControlValueTranslationResult {
    return {
        kind: 'control-value',
        attribute: 'value',
        complete: true,
        changed: true,
        sources: ['Save draft'],
        translations: ['保存草稿'],
        text: '保存草稿',
        ...overrides,
    };
}

function detachedSlot(document: Document, source: string) {
    const node = document.createTextNode(source);
    return {node, prefix: '', suffix: '', source};
}

describe('替换式译文提交', () => {
    beforeEach(() => {
        runtime.slots = null;
        vi.unstubAllGlobals();
    });

    it('控件先完成所有样式复验，再一次性撤下 loading 和写入译文', () => {
        const document = page('<main><button id="save">Save draft</button></main>');
        const node = document.querySelector<HTMLElement>('#save')!;
        const source = node.firstChild as Text;
        const attempt = beginTranslation(node, 'bilingual', 'control', false, 'Save draft', [source])!;
        const spinner = document.createElement('span');
        spinner.className = 'fluent-read-loading';
        node.append(spinner);
        setSpinner(node, spinner);
        let readsAfterRemoval = 0;
        Object.defineProperty(document.defaultView!, 'getComputedStyle', {configurable: true, value: () => {
            if (!spinner.isConnected) readsAfterRemoval++;
            return {display: 'block', visibility: 'visible', position: 'static', overflowY: 'visible'};
        }});
        expect(renderLiveTextResult(node, attempt.state, attempt.generation, liveResult({
            sources: ['Save draft'], translations: ['保存草稿'], nodes: [source],
        }), undefined, 'zh-CN')).toBe('committed');
        expect(readsAfterRemoval).toBe(0);
        expect(spinner.isConnected).toBe(false);
        expect(attempt.state.sourceHTML).toBe('Save draft');
        restoreTranslation(node);
        expect(node.textContent).toBe('Save draft');
    });

    it('冻结范围内的提交只收集一次实时槽，并拒绝宿主已替换的来源', () => {
        const document = page('<button id="save">Save draft</button>');
        const node = document.querySelector<HTMLElement>('#save')!;
        const original = node.firstChild as Text;
        const attempt = beginTranslation(node, 'bilingual', 'control', false, 'Save draft', [original])!;
        attempt.state.scope = 'all';
        node.textContent = 'Publish now';
        const actual = node.firstChild as Text;
        const read = vi.fn(() => [{node: actual, prefix: '', source: actual.data, suffix: ''}]);
        runtime.slots = read;
        expect(renderLiveTextResult(node, attempt.state, attempt.generation, liveResult({
            sources: ['Save draft'], translations: ['保存草稿'], nodes: [original],
        }), 'all', 'zh-CN')).toBe('stale');
        expect(read).toHaveBeenCalledTimes(1);
        expect(node.textContent).toBe('Publish now');
        node.textContent = 'Save draft';
        const replacement = node.firstChild as Text;
        read.mockImplementation(() => [{node: replacement, prefix: '', source: replacement.data, suffix: ''}]);
        expect(renderLiveTextResult(node, attempt.state, attempt.generation, liveResult({
            sources: ['Save draft'], translations: ['保存草稿'], nodes: [original],
        }), 'all', 'zh-CN')).toBe('committed');
        expect(read).toHaveBeenCalledTimes(2);
        expect(node.textContent).toBe('保存草稿');
        restoreTranslation(node);
        expect(node.textContent).toBe('Save draft');
    });

    it('按钮型 input 的译文写入标签属性，恢复原文时回滚插件自己的写入', () => {
        const document = page('<input id="save" type="button" value="Save draft">');
        const node = document.querySelector<HTMLElement>('#save')!;
        const attempt = beginTranslation(node, 'bilingual', 'control', false, 'Save draft', [])!;
        const spinner = document.createElement('span');
        node.after(spinner);
        setSpinner(node, spinner);

        expect(renderLiveTextResult(node, attempt.state, attempt.generation,
            controlValueResult(), 'content', 'zh-CN')).toBe('committed');
        expect(node.getAttribute('value')).toBe('保存草稿');
        expect(spinner.isConnected).toBe(false);
        expect(getTranslationState(node)).toMatchObject({phase: 'translated', textSlotsApplied: true});

        restoreTranslation(node);
        expect(node.getAttribute('value')).toBe('Save draft');
        expect(getTranslationState(node)).toBeUndefined();
    });

    it('宿主页在翻译期间改写了按钮标签时，恢复原文保持宿主页的最新值', () => {
        const document = page('<input id="save" type="button" value="Save draft">');
        const node = document.querySelector<HTMLElement>('#save')!;
        const attempt = beginTranslation(node, 'bilingual', 'control', false, 'Save draft', [])!;
        renderLiveTextResult(node, attempt.state, attempt.generation, controlValueResult(), 'content', 'zh-CN');

        node.setAttribute('value', 'Publish');
        restoreTranslation(node);
        expect(node.getAttribute('value')).toBe('Publish');
    });

    it('按钮标签缺少译文或译文与原文相同时不写入属性', () => {
        const document = page('<input id="a" type="button" value="Save draft">' +
            '<input id="b" type="button" value="Save draft">');
        const incomplete = document.querySelector<HTMLElement>('#a')!;
        const unchanged = document.querySelector<HTMLElement>('#b')!;

        const first = beginTranslation(incomplete, 'bilingual', 'control', false, 'Save draft', [])!;
        expect(renderLiveTextResult(incomplete, first.state, first.generation,
            controlValueResult({complete: false, translations: []}), 'content', 'zh-CN')).toBe('empty');
        expect(incomplete.getAttribute('value')).toBe('Save draft');
        expect(getTranslationState(incomplete)).toBeUndefined();

        const second = beginTranslation(unchanged, 'bilingual', 'control', false, 'Save draft', [])!;
        expect(renderLiveTextResult(unchanged, second.state, second.generation,
            controlValueResult({changed: false, translations: ['Save draft'], text: 'Save draft'}),
            'content', 'zh-CN')).toBe('unchanged');
        expect(unchanged.getAttribute('value')).toBe('Save draft');
        expect(getTranslationState(unchanged)).toBeUndefined();
    });

    it('按钮标签提交时代次已推进则判为过期，不写入属性', () => {
        const document = page('<input id="save" type="button" value="Save draft">');
        const node = document.querySelector<HTMLElement>('#save')!;
        const attempt = beginTranslation(node, 'bilingual', 'control', false, 'Save draft', [])!;

        expect(renderLiveTextResult(node, attempt.state, attempt.generation + 1,
            controlValueResult(), 'content', 'zh-CN')).toBe('stale');
        expect(node.getAttribute('value')).toBe('Save draft');
    });

    it('控件文本槽原位回写译文，跳过已经脱离文档的槽位', () => {
        const document = page('<button id="save">Save draft<span id="extra">Discard</span></button>');
        const node = document.querySelector<HTMLElement>('#save')!;
        const attached = node.firstChild as Text;
        const detached = detachedSlot(document as unknown as Document, 'Discard');
        runtime.slots = () => [
            {node: attached, prefix: ' ', suffix: '', source: 'Save draft'},
            detached,
        ];
        const attempt = beginTranslation(node, 'bilingual', 'control', false, 'Save draft', [])!;

        expect(renderLiveTextResult(node, attempt.state, attempt.generation, liveResult({
            sources: ['Save draft', 'Discard'],
            translations: ['保存草稿'],
            nodes: [attached, detached.node],
        }), 'content', 'zh-CN')).toBe('committed');
        expect(attached.nodeValue).toBe(' 保存草稿');
        // 没有对应译文的槽位保持原文，脱离文档的槽位完全不写入。
        expect(detached.node.nodeValue).toBe('Discard');
    });

    it('仅译文正文挂载闭合 Shadow 槽，槽位无法挂载时判为过期', () => {
        const document = page('<p id="prose">Original paragraph</p>');
        const node = document.querySelector<HTMLElement>('#prose')!;
        const attached = node.firstChild as Text;
        const first = beginTranslation(node, 'single', 'content', false, 'Original paragraph', [attached])!;

        expect(renderLiveTextResult(node, first.state, first.generation, liveResult({
            sources: ['Original paragraph'],
            translations: ['原始段落'],
            nodes: [attached],
        }), 'content', 'zh-CN')).toBe('committed');
        expect(getTranslationState(node)?.singleTextSlotHosts).toHaveLength(1);
        expect(node.querySelector('.fluent-read-single-slot')).not.toBeNull();

        restoreTranslation(node);
        const detached = detachedSlot(document as unknown as Document, 'Original paragraph');
        runtime.slots = () => [detached];
        const second = beginTranslation(node, 'single', 'content', false, 'Original paragraph', [])!;
        expect(renderLiveTextResult(node, second.state, second.generation, liveResult({
            sources: ['Original paragraph'],
            translations: ['原始段落'],
            nodes: [detached.node],
        }), 'content', 'zh-CN')).toBe('stale');
    });

    it('实时文本结果缺失、无变化或无法重新绑定时给出对应结论', () => {
        const document = page('<p id="a">Original paragraph</p><p id="b">Original paragraph</p>' +
            '<p id="c">Original paragraph</p><p id="d">Original paragraph</p>');
        const incomplete = document.querySelector<HTMLElement>('#a')!;
        const emptyUnchanged = document.querySelector<HTMLElement>('#b')!;
        const unchanged = document.querySelector<HTMLElement>('#c')!;
        const rebound = document.querySelector<HTMLElement>('#d')!;

        const first = beginTranslation(incomplete, 'single', 'content', false, 'Original paragraph', [])!;
        expect(renderLiveTextResult(incomplete, first.state, first.generation,
            liveResult({complete: false}), 'content', 'zh-CN')).toBe('empty');

        const second = beginTranslation(emptyUnchanged, 'single', 'content', false, 'Original paragraph', [])!;
        expect(renderLiveTextResult(emptyUnchanged, second.state, second.generation,
            liveResult({changed: false}), 'content', 'zh-CN')).toBe('empty');

        const third = beginTranslation(unchanged, 'single', 'content', false, 'Original paragraph', [])!;
        expect(renderLiveTextResult(unchanged, third.state, third.generation,
            liveResult({changed: false, nodes: [unchanged.firstChild as Text]}), 'content', 'zh-CN')).toBe('unchanged');

        // 请求期间宿主页替换了文本节点，译文无法按槽位对齐。
        const fourth = beginTranslation(rebound, 'single', 'content', false, 'Original paragraph', [])!;
        expect(renderLiveTextResult(rebound, fourth.state, fourth.generation, liveResult({
            sources: ['Replaced paragraph'],
            translations: ['替换后的段落'],
            nodes: [rebound.firstChild as Text],
        }), 'content', 'zh-CN')).toBe('stale');
    });

    it('实时文本槽提交时代次已推进则判为过期，不改写宿主文本', () => {
        const document = page('<p id="prose">Original paragraph</p>');
        const node = document.querySelector<HTMLElement>('#prose')!;
        const attached = node.firstChild as Text;
        const attempt = beginTranslation(node, 'single', 'content', false, 'Original paragraph', [attached])!;

        expect(renderLiveTextResult(node, attempt.state, attempt.generation + 1, liveResult({
            sources: ['Original paragraph'],
            translations: ['原始段落'],
            nodes: [attached],
        }), 'content', 'zh-CN')).toBe('stale');
        expect(attached.nodeValue).toBe('Original paragraph');
    });
});

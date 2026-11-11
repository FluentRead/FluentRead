import {parseHTML} from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import {
    canUseBundledDictionaryFallback,
    calculateSelectionPopupPosition,
    chooseSelectionRect,
    getSelectionPopupAnchor,
    getSelectionPresentationDelayRemaining,
    getEditableSelectionRoot,
    isSameLanguage,
    isSelectionExcludedTagName,
    normalizeSelectionText,
    readSelectionText,
    readSelectionParts,
    translateSelectionParts,
    normalizeSpeechLanguage,
    reconcileSelectionPresentation,
    resolveSelectionDictionaryFallback,
    selectionReverseTarget,
    resolveSelectionVocabularyAnswer,
    SelectionRequestTokenGate,
    shouldIgnoreSelection,
    summarizeSelectionContext,
} from '@/src/features/selection-translation/core';
import {
    buildEdgeTtsSsml,
    edgeTtsVoiceCandidatesForLanguage,
    synthesizeEdgeTts,
} from '@/src/features/selection-translation/services/edgeTts';
import { matchesConfiguredHotkey, matchesModifierOnlyHotkey, resolveConfiguredHotkey, shouldClaimConfiguredHotkey } from '@/src/core/hotkey';
import { normalizeSelectionTtsVoiceOrder, selectionTtsVoiceLocale } from '@/src/core/config/selectionTts';
import {detectlang} from '@/src/core/language/detect';

describe('中英划词方向', () => {
    it('只为当前目标语言的可信中英选区选择反向目标', () => {
        expect(selectionReverseTarget('你好，世界！', 'zh-Hans', 'auto')).toBe('en');
        expect(selectionReverseTarget('這是一段繁體中文。', 'zh-Hant', 'auto')).toBe('en');
        expect(selectionReverseTarget('This is an English sentence.', 'en', 'zh-Hant')).toBe('zh-Hant');
        expect(selectionReverseTarget('This is an English sentence.', 'en', 'auto')).toBe('zh-Hans');
        expect(selectionReverseTarget('This is an English sentence.', 'zh-Hans', 'auto')).toBeNull();
        expect(selectionReverseTarget('你好，世界！', 'ja', 'auto')).toBeNull();
        expect(selectionReverseTarget('API', 'en', 'auto')).toBeNull();
    });
});

interface MockElementOptions {
    nodeType?: number;
    tagName?: string;
    role?: string;
    attributes?: Record<string, string>;
    closestMatch?: boolean;
    isContentEditable?: boolean;
    parentElement?: MockElement | null;
    descendants?: MockElement[];
    clientRects?: Array<{width: number; height: number}>;
    contentRects?: Array<{width: number; height: number}>;
    querySelectorAllThrows?: boolean;
    getClientRectsThrows?: boolean;
    contentRangeFailure?: 'create' | 'select' | 'rects';
}

class MockElement {
    readonly nodeType: number;
    readonly tagName: string;
    readonly isContentEditable: boolean;
    readonly ownerDocument: Document | null;
    parentElement: MockElement | null;
    parentNode: MockElement | null = null;
    nextSibling: Node | null = null;
    childNodes: Node[] = [];
    private readonly attributes: Record<string, string>;
    private readonly closestMatch: boolean;
    private readonly descendants: MockElement[];
    private readonly clientRects: Array<{width: number; height: number}>;
    private readonly querySelectorAllThrows: boolean;
    private readonly getClientRectsThrows: boolean;

    constructor(options: MockElementOptions = {}) {
        this.nodeType = options.nodeType ?? 1;
        this.tagName = options.tagName ?? 'P';
        this.attributes = options.attributes ?? {};
        this.closestMatch = options.closestMatch === true;
        this.isContentEditable = options.isContentEditable === true;
        this.parentElement = options.parentElement ?? null;
        this.descendants = options.descendants ?? [];
        this.childNodes = this.descendants as unknown as Node[];
        this.descendants.forEach((node, index) => {
            node.parentNode = this;
            node.nextSibling = this.descendants[index + 1] as unknown as Node ?? null;
        });
        this.clientRects = options.clientRects ?? [];
        this.querySelectorAllThrows = options.querySelectorAllThrows === true;
        this.getClientRectsThrows = options.getClientRectsThrows === true;
        const contentRects = options.contentRects ?? [];
        this.ownerDocument = options.contentRects !== undefined || options.contentRangeFailure !== undefined
            ? {
                createRange: () => {
                    if (options.contentRangeFailure === 'create') throw new Error('content range creation failed');
                    return {
                        selectNodeContents: () => {
                            if (options.contentRangeFailure === 'select') throw new Error('content range selection failed');
                        },
                        getClientRects: () => {
                            if (options.contentRangeFailure === 'rects') throw new Error('content geometry failed');
                            return contentRects;
                        },
                    };
                },
            } as unknown as Document
            : null;
        if (options.role) this.attributes.role = options.role;
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    hasAttribute(name: string): boolean {
        return Object.hasOwn(this.attributes, name);
    }

    closest(selector: string): MockElement | null {
        return this.closestMatch && selector.includes('.notranslate') ? this : null;
    }

    get firstChild(): Node | null { return this.childNodes[0] ?? null; }

    matches(): boolean {
        if (this.querySelectorAllThrows) throw new Error('element matching failed');
        return isSelectionExcludedTagName(this.tagName) || Boolean(this.attributes.role) || this.closestMatch;
    }

    querySelectorAll(): MockElement[] {
        if (this.querySelectorAllThrows) throw new Error('query failed');
        return this.descendants;
    }

    getClientRects(): Array<{width: number; height: number}> {
        if (this.getClientRectsThrows) throw new Error('geometry failed');
        return this.clientRects;
    }
}

function mockTextNode(parentElement: MockElement | null): Node {
    return {nodeType: 3, parentElement, parentNode: parentElement, childNodes: [], firstChild: null, nextSibling: null} as unknown as Node;
}

interface MockRangeOptions {
    commonAncestor?: Node;
    intersectingNodes?: Node[];
    intersectionFailureNodes?: Node[];
}

function mockRange(start: Node | null, end: Node | null, options: MockRangeOptions = {}): Range {
    const commonAncestor = options.commonAncestor ?? new MockElement() as unknown as Node;
    // 旧用例保留独立的端点祖先语义，同时为实际范围遍历提供有序的标准子节点关系。
    if (commonAncestor instanceof MockElement && start && end) {
        const children = [...new Set([start, ...commonAncestor.childNodes, end])];
        (commonAncestor as MockElement).childNodes = children;
        children.forEach((node, index) => Object.assign(node, {parentNode: commonAncestor, nextSibling: children[index + 1] ?? null}));
    }
    return {
        startContainer: start,
        endContainer: end,
        startOffset: 0,
        endOffset: end?.nodeType === 3 ? end.textContent?.length ?? 0 : end?.childNodes?.length ?? 0,
        commonAncestorContainer: commonAncestor,
        intersectsNode: (node: Node) => {
            if (options.intersectionFailureNodes?.includes(node)) throw new Error('intersection failed');
            return options.intersectingNodes?.includes(node) === true;
        },
    } as unknown as Range;
}

describe('issue #704 inline code in prose selections', () => {
    function fixture(html: string, fragmentHtml = html) {
        const {document} = parseHTML('<html><body><main><p></p></main></body></html>');
        const paragraph = document.querySelector('p')!;
        paragraph.innerHTML = html;
        paragraph.querySelectorAll('*').forEach(element => {
            element.getClientRects = () => [{width: 20, height: 16}] as unknown as DOMRectList;
        });
        const range = mockRange(paragraph.firstChild, paragraph.lastChild, {
            commonAncestor: paragraph, intersectingNodes: [...paragraph.querySelectorAll('*')],
        });
        range.cloneContents = () => {
            const template = document.createElement('template');
            template.innerHTML = fragmentHtml;
            return template.content.cloneNode(true) as DocumentFragment;
        };
        return {document, paragraph, range};
    }

    it('allows prose crossing highlighted code and freezes exact code text without host attributes', () => {
        const {paragraph, range} = fixture('Run <code class="host" onclick="alert(1)"><span> a  &lt;b&gt; </span></code> <em>now.</em>');
        const before = paragraph.outerHTML;
        expect(shouldIgnoreSelection(range)).toBe(false);
        expect(readSelectionParts(range, 'browser text')).toEqual([
            {kind: 'text', text: 'Run '}, {kind: 'code', text: ' a  <b> '}, {kind: 'text', text: ' now.'},
        ]);
        expect(readSelectionText(range, 'browser text')).toBe('Run  a  <b>  now.');
        expect(paragraph.outerHTML).toBe(before);
    });

    it('keeps partial and multiple code fragments, line breaks and formula normalization', () => {
        const {range} = fixture('Read <code>first</code> and <code>second</code>.',
            '<code>st</code> and <code>sec</code> now.<br>Next <math>x</math>.');
        expect(readSelectionParts(range, '')).toEqual([
            {kind: 'code', text: 'st'}, {kind: 'text', text: ' and '},
            {kind: 'code', text: 'sec'}, {kind: 'text', text: ' now.\nNext $x$.'},
        ]);
        const blocks = fixture('<p>Use <code>x</code>.</p><p>Continue.</p>');
        expect(readSelectionText(blocks.range, '')).toBe('Use x.\n\nContinue.');
    });

    it('translates actively selected code-only content even inside a wrapper', () => {
        for (const html of ['<code>text</code>', ' <code>one</code>, <code>two</code> ']) {
            const {range} = fixture(html);
            expect(readSelectionParts(range, 'text')).toEqual([{kind: 'text', text: 'text'}]);
            expect(shouldIgnoreSelection(range)).toBe(false);
        }
        const {paragraph} = fixture('<code>word</code>');
        expect(readSelectionParts({commonAncestorContainer: paragraph.firstChild} as unknown as Range, 'word')).toEqual([{kind: 'text', text: 'word'}]);
    });

    it.each([
        '<code translate="no">command</code>',
        '<code class="notranslate">command</code>',
        '<code contenteditable="">command</code>',
        '<code><span contenteditable="true">command</span></code>',
        '<code role="button">command</code>',
        '<code role=" BUTTON ">command</code>',
        '<code><button>command</button></code>',
        '<span translate="no"><code>command</code></span>',
        '<button><code>command</code></button>',
        '<code aria-hidden="true">command</code>',
    ])('retains protected selection boundary: %s', html => {
        const {range} = fixture('Read ' + html + ' now.');
        expect(shouldIgnoreSelection(range)).toBe(true);
    });

    it('allows selection endpoints inside inline and block-styled code', () => {
        const {document, paragraph, range} = fixture('<code><span>part</span></code> of the sentence.');
        Object.assign(range, {startContainer: paragraph.querySelector('span')!.firstChild});
        expect(shouldIgnoreSelection(range)).toBe(false);
        const view = document.defaultView!;
        Object.defineProperty(view, 'getComputedStyle', {configurable: true, value: () => ({display: 'block'})});
        expect(shouldIgnoreSelection(range)).toBe(false);
        Object.defineProperty(view, 'getComputedStyle', {configurable: true, value: () => ({display: 'inline-block'})});
        expect(shouldIgnoreSelection(range)).toBe(false);
        delete (view as unknown as Record<string, unknown>).getComputedStyle;
    });

    it.each([
        '<pre>hello world</pre>',
        '<pre><code><span>hello</span> world</code></pre>',
        '<code style="display:block">hello world</code>',
    ])('issue #845 accepts code block words without modifying the host: %s', html => {
        const {paragraph, range} = fixture(html);
        const text = paragraph.querySelector('span')?.firstChild ?? paragraph.querySelector('code, pre')!.firstChild;
        Object.assign(range, {startContainer: text, endContainer: text, commonAncestorContainer: text});
        const before = paragraph.outerHTML;
        expect(shouldIgnoreSelection(range)).toBe(false);
        expect(readSelectionText(range, 'hello')).toBe('hello');
        expect(paragraph.outerHTML).toBe(before);
    });

    it.each([
        '<pre translate="no"><code>hello</code></pre>',
        '<pre class="notranslate"><code>hello</code></pre>',
        '<pre contenteditable=""><code>hello</code></pre>',
        '<pre><code><button>hello</button></code></pre>',
        '<pre aria-hidden="true"><code>hello</code></pre>',
    ])('issue #845 keeps protected code blocks excluded: %s', html => {
        const {range} = fixture('Read ' + html + ' now.');
        expect(shouldIgnoreSelection(range)).toBe(true);
    });

    it('allows semantic roles that are not interactive controls', () => {
        const {range} = fixture('Read <code role="note">command</code> now.');
        expect(shouldIgnoreSelection(range)).toBe(false);
    });

    it('sends only prose through batch translation and preserves code and punctuation locally', async () => {
        const parts = [{kind: 'text' as const, text: 'Run '}, {kind: 'code' as const, text: ' a  <b> '},
            {kind: 'text' as const, text: ' now. '}, {kind: 'code' as const, text: 'x'}, {kind: 'text' as const, text: '.'}];
        const translate = vi.fn().mockResolvedValue(['执行', '现在。']);
        const translated = await translateSelectionParts(parts, translate);
        expect(translate).toHaveBeenCalledWith(['Run', 'now.']);
        expect(translated.map(part => part.text).join('')).toBe('执行  a  <b>  现在。 x.');
        expect(translated.filter(part => part.kind === 'code')).toEqual(parts.filter(part => part.kind === 'code'));
        expect(parts[0].text).toBe('Run ');
        expect(await translateSelectionParts([{kind: 'code', text: '<script>'}], translate)).toEqual([{kind: 'code', text: '<script>'}]);
        expect(translate).toHaveBeenCalledTimes(1);
    });

    it('rejects failed or incomplete batches instead of exposing partial or stale translations', async () => {
        const parts = [{kind: 'text' as const, text: 'Read '}, {kind: 'code' as const, text: 'x'}];
        for (const results of [[], ['  ']]) {
            await expect(translateSelectionParts(parts, async () => results)).rejects.toThrow('Invalid selection translation');
        }
        await expect(translateSelectionParts(parts, async () => {throw new Error('cancelled');})).rejects.toThrow('cancelled');
    });
});

describe('explicit selections inside editable text', () => {
    function fixture(html: string) {
        const {document} = parseHTML('<html><body><main><p></p></main></body></html>');
        const paragraph = document.querySelector('p')!;
        paragraph.innerHTML = html;
        const range = mockRange(paragraph.firstChild, paragraph.lastChild, {
            commonAncestor: paragraph, intersectingNodes: [...paragraph.querySelectorAll('*')],
        });
        return {document, paragraph, range};
    }

    it('allows a complete range in one local editor only for the normal selection flow', () => {
        const inside = fixture('<span contenteditable="true">Read this editor text.</span>');
        expect(shouldIgnoreSelection(inside.range)).toBe(true);
        expect(shouldIgnoreSelection(inside.range, true)).toBe(false);

        const crossing = fixture('<span contenteditable="true">Editor text.</span> Outside text.');
        expect(shouldIgnoreSelection(crossing.range, true)).toBe(true);
    });

    it.each([
        '<span contenteditable="true" data-fluent-read-ui>Extension text.</span>',
        '<span contenteditable="true" aria-hidden="true">Hidden text.</span>',
        '<span contenteditable="true" translate="no">Protected text.</span>',
        '<textarea>Input text.</textarea>',
    ])('keeps protected editor content out: %s', html => {
        expect(shouldIgnoreSelection(fixture(html).range, true)).toBe(true);
    });

    it('recognizes textbox descendants and retains native controls inside an editor', () => {
        expect(shouldIgnoreSelection(fixture('<span role="textbox"><i>Editor text.</i></span>').range, true)).toBe(false);
        const input = fixture('<span contenteditable="true"><button>Protected action</button></span>');
        input.document.querySelector('button')!.getClientRects = () => [{width: 80, height: 20}] as unknown as DOMRectList;
        expect(shouldIgnoreSelection(input.range, true)).toBe(true);
        const crossing = fixture('Before <span role="textbox">Editor text.</span> after.');
        crossing.document.querySelector('[role="textbox"]')!.getClientRects = () => [{width: 80, height: 20}] as unknown as DOMRectList;
        expect(shouldIgnoreSelection(crossing.range, true)).toBe(true);
    });

    it('resolves inherited editability and stops at noneditable and document boundaries', () => {
        expect(getEditableSelectionRoot(null)).toBeNull();
        const {document} = fixture('Text');
        expect(getEditableSelectionRoot(document)).toBeNull();
        document.body.setAttribute('contenteditable', 'true');
        expect(getEditableSelectionRoot(document.body)).toBeNull();
        const parent = document.createElement('section');
        Object.defineProperty(parent, 'isContentEditable', {value: false});
        const editor = document.createElement('div');
        Object.defineProperty(editor, 'isContentEditable', {value: true});
        parent.append(editor);
        expect(getEditableSelectionRoot(editor)).toBe(editor);
        editor.remove();
        expect(getEditableSelectionRoot(editor)).toBe(editor);
        editor.setAttribute('contenteditable', 'false');
        expect(getEditableSelectionRoot(editor)).toBeNull();
        editor.innerHTML = '<span contenteditable="true">Local editor</span>';
        expect(getEditableSelectionRoot(editor.firstChild)).toBe(editor.firstChild);
    });

    it.each(['missing', 'throws'] as const)('checks ancestry when an editor contains method %s', mode => {
        const value = fixture('<span contenteditable="true"><i>Selected text.</i></span>');
        Object.defineProperty(value.paragraph.firstChild, 'contains', {value: mode === 'missing' ? undefined
            : () => {throw new Error('host contains unavailable');}});
        const text = value.document.querySelector('i')!.firstChild!;
        expect(shouldIgnoreSelection(mockRange(text, text, {commonAncestor: text}), true)).toBe(false);
    });
});

describe('document no-translate shells in explicit selections', () => {
    function fixture(htmlAttributes = '', bodyAttributes = '', content = '<p id="content">Readable response text.</p>') {
        const {document} = parseHTML(`<html ${htmlAttributes}><head></head><body ${bodyAttributes}><div id="root">${content}</div></body></html>`);
        const text = document.querySelector('#content')!.firstChild!;
        return {document, text, range: mockRange(text, text, {commonAncestor: text})};
    }

    it.each(['class="notranslate"', 'translate="no"', 'data-notranslate="true"'])('allows html/body shell marker %s', attributes => {
        for (const surface of ['html', 'body']) {
            const {document, range} = fixture(surface === 'html' ? attributes : '', surface === 'body' ? attributes : '');
            const before = document.documentElement.outerHTML;
            expect(shouldIgnoreSelection(range)).toBe(false);
            expect(document.documentElement.outerHTML).toBe(before);
        }
    });

    it('allows combined DeepSeek root markers, repeated checks and replacement response nodes', () => {
        const {document, range} = fixture('class="notranslate" translate="no"', 'class="notranslate"');
        const root = document.querySelector('#root')!;
        root.classList.add('notranslate');
        expect(shouldIgnoreSelection(range)).toBe(false);
        expect(shouldIgnoreSelection(range)).toBe(false);
        root.innerHTML = '<p id="content">A newly generated response.</p>';
        const text = root.firstChild!.firstChild!;
        expect(shouldIgnoreSelection(mockRange(text, text, {commonAncestor: text}))).toBe(false);
    });

    it.each(['class="notranslate"', 'translate="no"', 'data-notranslate="true"'])('keeps nested local marker %s protected', attributes => {
        const {range} = fixture('class="notranslate" translate="no"', '', `<section ${attributes}><p id="content">Protected local response.</p></section>`);
        expect(shouldIgnoreSelection(range)).toBe(true);
    });

    it.each(['role="button"', 'contenteditable="true"', 'aria-hidden="true"', 'data-fluent-read-ui="true"', 'class="fluent-read-loading"'])('keeps root protection %s alongside no-translate shells', attributes => {
        for (const surface of ['html', 'body']) {
            const {document, range} = fixture('translate="no"', 'translate="no"');
            const target = surface === 'html' ? document.documentElement : document.body;
            const attribute = parseHTML(`<html><body><div ${attributes}></div></body></html>`).document.querySelector('div')!.attributes[0]!;
            target.setAttribute(attribute.name, attribute.value);
            // 直接子级应用外壳不能掩盖根级保护。
            document.querySelector('#root')!.classList.add('notranslate');
            expect(shouldIgnoreSelection(range)).toBe(true);
        }
    });

    it('allows body range boundaries while still rejecting a visible local protected descendant', () => {
        const {document} = fixture('class="notranslate" translate="no"', 'translate="no"');
        const range = mockRange(document.body, document.body, {commonAncestor: document.body});
        expect(shouldIgnoreSelection(range)).toBe(false);
        const local = document.createElement('span');
        local.className = 'notranslate';
        local.textContent = 'Protected local source.';
        local.getClientRects = () => [{width: 100, height: 20}] as unknown as DOMRectList;
        document.querySelector('#root')!.append(local);
        expect(shouldIgnoreSelection(mockRange(document.body, document.body, {
            commonAncestor: document.body, intersectingNodes: [local],
        }))).toBe(true);
    });
});

describe('selection range traversal scope and cost', () => {
    function rangeIn(_document: Document, start: Node, startOffset: number, end: Node, endOffset: number, root?: Node): Range {
        let common: Node | null = start;
        while (common && common !== end && !common.contains(end)) common = common.parentNode;
        return {startContainer: start, startOffset, endContainer: end, endOffset,
            commonAncestorContainer: root ?? common!, intersectsNode: () => true} as unknown as Range;
    }

    function changelogFixture(decoration = '<svg aria-hidden="true" width="16" height="16"><path d="M0 0h16v16H0z"/></svg>') {
        const {document} = parseHTML(`<html><body><main><h2>Latest from our changelog</h2><ul>
            <li>${decoration}<div><time>Nov 11, 2026</time><a id="first">First changelog entry.</a></div></li>
            <li>${decoration}<div><time>Nov 10, 2026</time><a id="last">Second changelog entry.</a></div></li>
        </ul><a id="all">View changelog</a></main></body></html>`);
        document.querySelectorAll('*').forEach(element => {
            element.getClientRects = () => [{width: 16, height: 16}] as unknown as DOMRectList;
        });
        const first = document.querySelector('#first')!.firstChild!;
        const last = document.querySelector('#last')!.firstChild!;
        return {document, first, last};
    }

    it.each([false, true])('issue #1317 allows cross-entry and whole-block selections past decorative SVGs (editable=%s)', allowEditable => {
        const {document, first, last} = changelogFixture();
        const title = document.querySelector('h2')!.firstChild!;
        const all = document.querySelector('#all')!.firstChild!;
        const time = document.querySelector('time')!.firstChild!;
        for (const [start, end] of [[first, first], [title, title], [time, first], [first, last], [title, all]]) {
            expect(shouldIgnoreSelection(rangeIn(document, start, 0, end, end.textContent!.length), allowEditable)).toBe(false);
        }
    });

    it.each([
        '<svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg>',
        '<span aria-hidden="true"><svg><path d="M0 0h16v16H0z"/></svg></span>',
        '<span aria-hidden="true"> \n </span>',
    ])('issue #1317 allows textless decoration between selected entries: %s', decoration => {
        const {document, first, last} = changelogFixture(decoration);
        expect(shouldIgnoreSelection(rangeIn(document, first, 0, last, last.textContent!.length))).toBe(false);
    });

    it.each([
        '<button>Protected action</button>',
        '<span role="button">Protected action</span>',
        '<span translate="no">Protected text</span>',
        '<span class="notranslate">Protected text</span>',
        '<span data-notranslate="true">Protected text</span>',
        '<span aria-hidden="true">Protected text</span>',
        '<svg aria-hidden="true"><text>Protected text</text></svg>',
        '<span data-fluent-read-ui>Extension text</span>',
        '<span contenteditable="true">Editor text</span>',
        '<button aria-hidden="true"></button>',
        '<svg role="button"></svg>',
        '<span role="textbox" aria-hidden="true"></span>',
    ])('issue #1317 still rejects protected content after a decorative icon: %s', protectedHtml => {
        const {document, first, last} = changelogFixture();
        const entry = document.querySelectorAll('li')[1];
        entry.insertAdjacentHTML('afterbegin', protectedHtml);
        entry.firstElementChild!.getClientRects = () => [{width: 30, height: 20}] as unknown as DOMRectList;
        expect(shouldIgnoreSelection(rangeIn(document, first, 0, last, last.textContent!.length), true)).toBe(true);
    });

    it('short cross-paragraph selections never query or visit thousands of unselected sibling subtrees', () => {
        const {document} = parseHTML(`<html><body><main><aside id="before">${'<button>Before</button>'.repeat(5000)}</aside><p id="a">Selected first.</p><p id="b">Selected second.</p><aside id="after">${'<button>After</button>'.repeat(5000)}</aside></main></body></html>`);
        const main = document.querySelector('main')!;
        const a = document.querySelector('#a')!.firstChild!;
        const b = document.querySelector('#b')!.firstChild!;
        const query = vi.spyOn(main, 'querySelectorAll');
        const before = vi.spyOn(document.querySelector('#before')!, 'matches');
        const after = vi.spyOn(document.querySelector('#after')!, 'matches');
        const matching = vi.spyOn(document.querySelector('#b')!, 'matches');
        const range = rangeIn(document, a, 0, b, 8);
        expect(shouldIgnoreSelection(range)).toBe(false);
        expect(query).not.toHaveBeenCalled();
        expect(before).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
        // 结束点位于下一段正文，只需检查这一段元素本身，不随页外按钮数量增长。
        expect(matching).toHaveBeenCalledTimes(1);
    });

    it('formulas and code outside a short selected range never trigger an ancestor query or fragment cloning', () => {
        const {document} = parseHTML('<html><body><main><math><mi>Outside formula</mi></math><p id="a">Selected first.</p><p id="b">Selected second.</p><code>Outside code</code></main></body></html>');
        const main = document.querySelector('main')!;
        const a = document.querySelector('#a')!.firstChild!;
        const b = document.querySelector('#b')!.firstChild!;
        const range = rangeIn(document, a, 2, b, 8);
        const clone = vi.fn(() => document.createDocumentFragment());
        range.cloneContents = clone;
        const query = vi.spyOn(main, 'querySelector');
        expect(readSelectionParts(range, 'lected first. Selected')).toEqual([{kind: 'text', text: 'lected first. Selected'}]);
        expect(query).not.toHaveBeenCalled();
        expect(clone).not.toHaveBeenCalled();
    });

    it.each(['start', 'end'])('partial %s endpoints inside code preserve the selected code fragment', edge => {
        const {document} = parseHTML('<html><body><p>Before <code><span>command</span></code> after.</p></body></html>');
        const paragraph = document.querySelector('p')!;
        const codeText = document.querySelector('span')!.firstChild!;
        const range = edge === 'start' ? rangeIn(document, codeText, 3, paragraph.lastChild!, 3)
            : rangeIn(document, paragraph.firstChild!, 2, codeText, 4);
        const fragment = document.createElement('template');
        fragment.innerHTML = edge === 'start' ? '<code>mand</code> af' : 'fore <code>comm</code>';
        const clone = vi.fn(() => fragment.content.cloneNode(true) as DocumentFragment);
        range.cloneContents = clone;
        const query = vi.spyOn(paragraph, 'querySelector');
        expect(readSelectionParts(range, 'browser text')).toEqual(edge === 'start'
            ? [{kind: 'code', text: 'mand'}, {kind: 'text', text: ' af'}]
            : [{kind: 'text', text: 'fore '}, {kind: 'code', text: 'comm'}]);
        expect(clone).toHaveBeenCalledOnce();
        expect(query).not.toHaveBeenCalled();
    });

    it.each(['start', 'end'])('partial %s endpoints inside formulas retain a single readable representation', edge => {
        const {document} = parseHTML('<html><body><p>Before <span class="MathJax"><nobr aria-hidden="true">x2</nobr></span> after.</p></body></html>');
        const paragraph = document.querySelector('p')!;
        const formulaText = document.querySelector('nobr')!.firstChild!;
        const range = edge === 'start' ? rangeIn(document, formulaText, 1, paragraph.lastChild!, 6)
            : rangeIn(document, paragraph.firstChild!, 2, formulaText, 1);
        const fragment = document.createElement('template');
        fragment.innerHTML = edge === 'start' ? '<span class="MathJax"><nobr>2</nobr></span> after'
            : 'fore <span class="MathJax"><nobr>x</nobr></span>';
        const clone = vi.fn(() => fragment.content.cloneNode(true) as DocumentFragment);
        range.cloneContents = clone;
        expect(readSelectionText(range, 'browser text')).toBe(edge === 'start' ? '$2$ after' : 'fore $x$');
        expect(clone).toHaveBeenCalledOnce();
    });

    it('element boundaries use a half-open child interval and leave adjacent visible controls untouched', () => {
        const {document} = parseHTML('<html><body><main><button id="before">Before</button><p>Readable text</p><button id="after">After</button></main></body></html>');
        const main = document.querySelector('main')!;
        const before = document.querySelector('#before')!;
        const after = document.querySelector('#after')!;
        before.getClientRects = after.getClientRects = () => [{width: 30, height: 20}] as unknown as DOMRectList;
        const beforeGeometry = vi.spyOn(before, 'getClientRects');
        const afterGeometry = vi.spyOn(after, 'getClientRects');
        expect(shouldIgnoreSelection(rangeIn(document, main, 1, main, 2))).toBe(false);
        expect(beforeGeometry).not.toHaveBeenCalled();
        expect(afterGeometry).not.toHaveBeenCalled();
        expect(shouldIgnoreSelection(rangeIn(document, main, 0, main, 2))).toBe(true);
        expect(shouldIgnoreSelection(rangeIn(document, main, 1, main, 3))).toBe(true);
    });

    it('accepts a paragraph selection ending at the empty leading edge of an adjacent protected code block', () => {
        const {document} = parseHTML('<html><body><article><p>Read <code>--version</code> and see the <a>guide</a>.</p>\n<div class="notranslate"><pre><span>Private command</span></pre><button>Copy</button></div></article></body></html>');
        const start = document.querySelector('p')!.firstChild!;
        const pre = document.querySelector('pre')!;
        const command = pre.querySelector('span')!.firstChild!;
        const protectedBlock = pre.parentElement!;
        protectedBlock.getClientRects = () => [{width: 100, height: 40}] as unknown as DOMRectList;
        const geometry = vi.spyOn(protectedBlock, 'getClientRects');

        expect(shouldIgnoreSelection(rangeIn(document, start, 0, pre, 0))).toBe(false);
        expect(shouldIgnoreSelection(rangeIn(document, start, 0, command, 0))).toBe(false);
        expect(geometry).not.toHaveBeenCalled();
        expect(shouldIgnoreSelection(rangeIn(document, start, 0, command, 1))).toBe(true);
        expect(shouldIgnoreSelection(rangeIn(document, start, 0, protectedBlock, 1))).toBe(true);
    });

    it('empty element boundary positions move to the next subtree without leaving the common ancestor', () => {
        const {document} = parseHTML('<html><body><main><p id="a">First</p><section id="end"><span>Second</span></section><button>Outside</button></main></body></html>');
        const first = document.querySelector('#a')!;
        const end = document.querySelector('#end')!;
        const outside = document.querySelector('button')!;
        outside.getClientRects = () => [{width: 20, height: 20}] as unknown as DOMRectList;
        const geometry = vi.spyOn(outside, 'getClientRects');
        expect(shouldIgnoreSelection(rangeIn(document, first, first.childNodes.length, end, end.childNodes.length))).toBe(false);
        expect(geometry).not.toHaveBeenCalled();
        expect(shouldIgnoreSelection(rangeIn(document, first, 1, first, 1))).toBe(false);
    });

    it('an empty nested start skips completed ancestor branches and a zero end offset excludes all end children', () => {
        const {document} = parseHTML('<html><body><main><section><p><button>Before</button><em id="empty"></em></p></section><p id="end">Selected end <button id="outside">Outside</button></p></main></body></html>');
        const empty = document.querySelector('#empty')!;
        const end = document.querySelector('#end')!;
        const outside = document.querySelector('#outside')!;
        outside.getClientRects = () => [{width: 20, height: 20}] as unknown as DOMRectList;
        const geometry = vi.spyOn(outside, 'getClientRects');
        expect(shouldIgnoreSelection(rangeIn(document, empty, 0, end, 0))).toBe(false);
        expect(shouldIgnoreSelection(rangeIn(document, empty, 0, end.firstChild!, 8))).toBe(false);
        expect(geometry).not.toHaveBeenCalled();
    });

    it('mixed text and element boundaries still reject interior controls and stop at the exact end', () => {
        const {document} = parseHTML('<html><body><main><p id="a">Start</p><button id="inside">Action</button><p id="b">End</p><button id="outside">Outside</button></main></body></html>');
        const main = document.querySelector('main')!;
        const start = document.querySelector('#a')!.firstChild!;
        const end = document.querySelector('#b')!.firstChild!;
        const inside = document.querySelector('#inside')!;
        inside.getClientRects = () => [{width: 20, height: 20}] as unknown as DOMRectList;
        expect(shouldIgnoreSelection(rangeIn(document, start, 2, main, 3))).toBe(true);
        expect(shouldIgnoreSelection(rangeIn(document, main, 0, end, 1))).toBe(true);
        inside.remove();
        expect(shouldIgnoreSelection(rangeIn(document, start, 2, main, 2))).toBe(false);
    });

    it('Document and ShadowRoot element boundaries inspect only selected children', () => {
        const {document} = parseHTML('<html><body><div id="host"></div></body></html>');
        const root = document.querySelector('#host')!.attachShadow({mode: 'open'});
        root.innerHTML = '<p>Readable</p><button>Action</button>';
        root.querySelector('button')!.getClientRects = () => [{width: 20, height: 20}] as unknown as DOMRectList;
        expect(shouldIgnoreSelection(rangeIn(document, root, 0, root, 1))).toBe(false);
        expect(shouldIgnoreSelection(rangeIn(document, root, 0, root, 2))).toBe(true);
        expect(shouldIgnoreSelection(rangeIn(document, document, 0, document, 1))).toBe(false);
    });

    it('deep plain-text endpoints inspect each ancestor once rather than repeatedly searching editor ancestry', () => {
        const depth = 300;
        let parent: MockElement | null = null;
        const ancestors: MockElement[] = [];
        for (let index = 0; index < depth; index += 1) {
            parent = new MockElement({parentElement: parent});
            ancestors.push(parent);
        }
        const checks = ancestors.map(element => vi.spyOn(element, 'hasAttribute'));
        const text = mockTextNode(parent);
        expect(shouldIgnoreSelection(mockRange(text, text, {commonAncestor: text}))).toBe(false);
        expect(checks.reduce((count, check) => count + check.mock.calls.length, 0)).toBe(depth * 2);
    });

    it.each(['true', 'plaintext-only', '', ' INVALID '])('retains editor protection across nested contenteditable=false: %s', editable => {
        const {document} = parseHTML(`<html><body><div contenteditable="${editable}"><span contenteditable="false">Readable text</span></div></body></html>`);
        const text = document.querySelector('span')!.firstChild!;
        expect(shouldIgnoreSelection(rangeIn(document, text, 0, text, 5))).toBe(true);
    });

    it('zero-length text boundaries do not visit protected content outside the selected text node', () => {
        const {document} = parseHTML('<html><body><p>Readable <button>Outside</button></p></body></html>');
        const text = document.querySelector('p')!.firstChild!;
        const button = document.querySelector('button')!;
        const matching = vi.spyOn(button, 'matches');
        expect(shouldIgnoreSelection(rangeIn(document, text, 1, text, 3))).toBe(false);
        expect(shouldIgnoreSelection(rangeIn(document, text, 1, text, 1))).toBe(false);
        expect(matching).not.toHaveBeenCalled();
    });

    it('semantic noneditable notes and crossed top-level application shells retain their exceptions', () => {
        const {document} = parseHTML('<html><body><p id="start">Start</p><div class="notranslate"><span contenteditable="false" role="note">Readable note</span></div><p id="end">End</p></body></html>');
        const start = document.querySelector('#start')!.firstChild!;
        const end = document.querySelector('#end')!.firstChild!;
        const note = document.querySelector('span')!;
        // linkedom 只根据属性存在判断编辑状态；浏览器对 contenteditable=false 返回 false。
        Object.defineProperty(note, 'isContentEditable', {value: false});
        const geometry = vi.fn(() => [{width: 30, height: 20}] as unknown as DOMRectList);
        note.getClientRects = geometry;
        expect(shouldIgnoreSelection(rangeIn(document, start, 1, end, 2))).toBe(false);
        expect(geometry).not.toHaveBeenCalled();
    });
});

describe('selection translator core geometry', () => {
    const rects = [
        { top: 100, right: 300, bottom: 124, left: 80, width: 220, height: 24 },
        { top: 124, right: 180, bottom: 148, left: 80, width: 100, height: 24 },
    ];

    it('anchors a forward multi-line selection at its visual end', () => {
        expect(chooseSelectionRect(rects, true)).toEqual(rects[1]);
        expect(chooseSelectionRect(rects, false)).toEqual(rects[0]);
        expect(chooseSelectionRect([])).toBeNull();
    });

    it('keeps every selected line clear while aligning to the directional endpoint', () => {
        expect(getSelectionPopupAnchor([])).toBeNull();
        expect(getSelectionPopupAnchor([rects[0]])).toEqual(rects[0]);
        expect(getSelectionPopupAnchor(rects)).toEqual({...rects[1], top: 100, height: 48});
        expect(getSelectionPopupAnchor(rects, false)).toEqual({...rects[0], bottom: 148, height: 48});
        const anchor = getSelectionPopupAnchor(rects)!;
        const card = calculateSelectionPopupPosition(anchor, {width: 360, height: 80}, {width: 1000, height: 500});
        expect(card.top + 80 <= anchor.top - 10 || card.top >= anchor.bottom + 10).toBe(true);
    });

    it('keeps the popup above the selection when there is room', () => {
        expect(calculateSelectionPopupPosition({ ...rects[0], top: 300, bottom: 324 }, { width: 360, height: 160 }, { width: 1200, height: 800 })).toEqual({
            left: 80,
            top: 130,
            placement: 'top',
        });
    });

    it('flips below and clamps to the viewport near the top edge', () => {
        expect(calculateSelectionPopupPosition({ top: 20, right: 30, bottom: 42, left: 4, width: 26, height: 22 }, { width: 360, height: 160 }, { width: 390, height: 300 })).toEqual({
            left: 12,
            top: 52,
            placement: 'bottom',
        });
    });

    it('uses a panned visual viewport origin when keyboard or zoom changes the visible region', () => {
        expect(calculateSelectionPopupPosition({top: 120, bottom: 144, left: 20, right: 100, width: 80, height: 24},
            {width: 280, height: 160}, {left: 80, top: 100, width: 320, height: 300}))
            .toEqual({left: 92, top: 154, placement: 'bottom'});
    });

    it.each([
        {top: 100, bottom: 125, expected: {top: 135, placement: 'bottom', maxHeight: 123}},
        {top: 160, bottom: 185, expected: {top: 12, placement: 'top', maxHeight: 138}},
        {top: 123, bottom: 147, expected: {top: 12, placement: 'top', maxHeight: 101}},
    ])('bounds a tall card beside the selected line: $top–$bottom', ({top, bottom, expected}) => {
        expect(calculateSelectionPopupPosition({top, bottom, left: 80, right: 180, width: 100, height: bottom - top},
            {width: 360, height: 520}, {width: 1000, height: 270})).toEqual({left: 80, ...expected});
    });

    it.each([
        {top: 500, bottom: 524, placement: 'top'},
        {top: -100, bottom: -76, placement: 'bottom'},
    ] as const)('bounds a saved anchor outside the visible viewport: $placement', ({top, bottom, placement}) => {
        expect(calculateSelectionPopupPosition({top, bottom, left: 80, right: 180, width: 100, height: 24},
            {width: 360, height: 520}, {width: 1000, height: 300}))
            .toEqual({left: 80, top: 12, placement, maxHeight: 276});
    });

    it('keeps visible lines clear across card heights and viewport sizes', () => {
        for (const viewportHeight of [170, 270, 500, 900]) {
            for (let top = 12; top <= viewportHeight - 36; top += 17) {
                const anchor = {top, bottom: top + 24, left: 80, right: 180, width: 100, height: 24};
                for (const height of [80, 240, 520]) {
                    const result = calculateSelectionPopupPosition(anchor, {width: 360, height}, {width: 1000, height: viewportHeight});
                    const displayedHeight = result.maxHeight ?? height;
                    expect(result.top).toBeGreaterThanOrEqual(12);
                    expect(result.top + displayedHeight).toBeLessThanOrEqual(viewportHeight - 12);
                    expect(result.top + displayedHeight <= anchor.top - 10 || result.top >= anchor.bottom + 10).toBe(true);
                }
            }
        }
    });


});

describe('selection translator presentation stability', () => {
    it('keeps a live delay change anchored to the original selection time', () => {
        expect(getSelectionPresentationDelayRemaining(300, 1_000, 1_120)).toBe(180);
        expect(getSelectionPresentationDelayRemaining(100, 1_000, 1_120)).toBe(0);
        expect(getSelectionPresentationDelayRemaining(300, 1_000, 900)).toBe(300);
    });

    it('preserves an explicitly opened tooltip across unrelated config refreshes', () => {
        const openTooltip = {showIndicator: false, showTooltip: true};
        expect(reconcileSelectionPresentation(openTooltip, 'shortcut', false)).toBe(openTooltip);
        expect(reconcileSelectionPresentation(openTooltip, 'contextMenu', false)).toBe(openTooltip);
        expect(reconcileSelectionPresentation(openTooltip, 'icon', false)).toBe(openTooltip);
        expect(reconcileSelectionPresentation(openTooltip, 'dot', false)).toBe(openTooltip);
    });

    it('updates presentation only when the configured trigger actually changes', () => {
        const openTooltip = {showIndicator: false, showTooltip: true};
        expect(reconcileSelectionPresentation(openTooltip, 'direct', true)).toEqual({showIndicator: false, showTooltip: true});
        expect(reconcileSelectionPresentation(openTooltip, 'icon', true)).toEqual({showIndicator: true, showTooltip: false});
        expect(reconcileSelectionPresentation(openTooltip, 'dot', true)).toEqual({showIndicator: true, showTooltip: false});
        expect(reconcileSelectionPresentation(openTooltip, 'shortcut', true)).toEqual({showIndicator: false, showTooltip: false});
        expect(reconcileSelectionPresentation(openTooltip, 'contextMenu', true)).toEqual({showIndicator: false, showTooltip: false});
    });
});

describe('selection translator async request generations', () => {
    it('keeps vocabulary lookup refreshes independent from an in-flight save', () => {
        const lookupGate = new SelectionRequestTokenGate();
        const saveGate = new SelectionRequestTokenGate();
        const saveToken = saveGate.begin();
        const firstLookup = lookupGate.begin();
        const refreshedLookup = lookupGate.begin();

        expect(lookupGate.isCurrent(firstLookup)).toBe(false);
        expect(lookupGate.isCurrent(refreshedLookup)).toBe(true);
        expect(saveGate.isCurrent(saveToken)).toBe(true);
    });

    it('invalidates both channels when the active selection is reset', () => {
        const lookupGate = new SelectionRequestTokenGate();
        const saveGate = new SelectionRequestTokenGate();
        const lookupToken = lookupGate.begin();
        const saveToken = saveGate.begin();

        lookupGate.invalidate();
        saveGate.invalidate();

        expect(lookupGate.isCurrent(lookupToken)).toBe(false);
        expect(saveGate.isCurrent(saveToken)).toBe(false);
    });
});

describe('selection translator text and speech language normalization', () => {
    it('matches detected languages with configured language families', () => {
        expect(isSameLanguage('zh-Hans', 'zh-Hant')).toBe(false);
        expect(isSameLanguage('zh-Hant', 'zh-Hans')).toBe(false);
        expect(isSameLanguage('zh_Hant_CN', 'zh-TW')).toBe(true);
        expect(isSameLanguage('zh-Hans-TW', 'zh-CN')).toBe(true);
        expect(isSameLanguage('zh', 'zh-Hans')).toBe(false);
        expect(isSameLanguage('cmn', 'zh-Hant')).toBe(false);
        expect(isSameLanguage('zh-Hant', 'cmn')).toBe(false);
        expect(isSameLanguage('yue', 'zh-Hant')).toBe(false);
        expect(isSameLanguage('eng', 'en')).toBe(true);
        expect(isSameLanguage('ja', 'en')).toBe(false);
        expect(isSameLanguage(undefined, 'en')).toBe(false);
        expect(isSameLanguage('en', undefined)).toBe(false);
        expect(isSameLanguage('und', 'en')).toBe(false);
        expect(isSameLanguage('en', 'auto')).toBe(false);
    });

    it('normalizes browser whitespace without changing words', () => {
        expect(normalizeSelectionText('  hello\u00a0  world\n   again  ')).toBe('hello world\nagain');
    });

    it('keeps a bounded context centered on the selected word', () => {
        expect(summarizeSelectionContext('', 'common')).toBe('');
        expect(summarizeSelectionContext('common text', '')).toBe('');
        expect(summarizeSelectionContext('common text', 'common', 10)).toBe('');
        const context = summarizeSelectionContext(`Before ${'a'.repeat(80)} common ${'b'.repeat(80)} after`, 'common', 64);
        expect(context).toHaveLength(64);
        expect(context).toContain('common');
        expect(context.startsWith('…')).toBe(true);
        expect(context.endsWith('…')).toBe(true);
        expect(summarizeSelectionContext('  A   common\nexample. ', 'common')).toBe('A common example.');
        expect(summarizeSelectionContext(`${'x'.repeat(80)} tail`, 'missing', 40)).toBe(`${'x'.repeat(39)}…`);
        const repeated = `common FIRST ${'x'.repeat(650)} common SECOND`;
        const lastCommon = repeated.lastIndexOf('common');
        const aroundLast = summarizeSelectionContext(repeated, 'common', 80, lastCommon);
        expect(aroundLast).toContain('SECOND');
        expect(aroundLast).not.toContain('FIRST');
        expect(summarizeSelectionContext(`${'x'.repeat(40)} common tail ${'y'.repeat(80)}`, 'common', 40, 0)).toContain('common');
        expect(summarizeSelectionContext(`${'x'.repeat(80)} common tail`, 'common', 40, 500)).toContain('common');
        expect(summarizeSelectionContext(`common left ${'x'.repeat(40)} common right`, 'common', 40, 45)).toContain('right');
        expect(summarizeSelectionContext(`common ${'x'.repeat(80)}`, 'common', 40, 0).startsWith('common')).toBe(true);
    });

    it('only exposes answers completed for the current selection request', () => {
        const current = {text: 'common', targetLanguage: 'zh-Hans', generation: 3};
        const translated = {...current, answer: '常见的'};
        const dictionary = {...current, answer: 'occurring often'};
        expect(resolveSelectionVocabularyAnswer(null, translated, dictionary)).toBe('');
        expect(resolveSelectionVocabularyAnswer(current, translated, dictionary)).toBe('常见的');
        expect(resolveSelectionVocabularyAnswer(current, {...translated, text: 'current'}, dictionary)).toBe('occurring often');
        expect(resolveSelectionVocabularyAnswer(current, {...translated, targetLanguage: 'ja'}, null)).toBe('');
        expect(resolveSelectionVocabularyAnswer(current, {...translated, generation: 2}, null)).toBe('');
    });

    it('only uses bundled ECDICT auxiliary text for Simplified Chinese targets', () => {
        expect(canUseBundledDictionaryFallback('zh-Hans')).toBe(true);
        expect(canUseBundledDictionaryFallback('')).toBe(false);
        expect(canUseBundledDictionaryFallback('ZH_cn')).toBe(true);
        expect(canUseBundledDictionaryFallback('zh-Hant')).toBe(false);
        expect(canUseBundledDictionaryFallback('ja')).toBe(false);
        expect(resolveSelectionDictionaryFallback('zh-Hans', [undefined, '', ' 常见 ', '共同'])).toBe('常见；共同');
        expect(resolveSelectionDictionaryFallback('ja', ['常见'])).toBe('');
    });

    it('issue #492 extracts one formula representation from MathJax and KaTeX selections', () => {
        const {document} = parseHTML(`<html><body><p>For each integer <span class="MathJax"><nobr aria-hidden="true">i</nobr><span class="MJX_Assistive_MathML"><math><mi>i</mi></math></span></span><script type="math/tex">i</script> find the answer.</p></body></html>`);
        const paragraph = document.querySelector('p')!;
        const selected = () => {
            const fragment = document.createDocumentFragment();
            [...paragraph.childNodes].forEach(node => fragment.append(node.cloneNode(true)));
            return fragment;
        };
        const range = {
            commonAncestorContainer: paragraph,
            get startContainer() { return paragraph.firstChild; }, startOffset: 0,
            get endContainer() { return paragraph.lastChild; },
            get endOffset() { return paragraph.lastChild?.nodeType === 3 ? paragraph.lastChild.textContent!.length : paragraph.lastChild?.childNodes.length ?? 0; },
            cloneContents: selected,
        } as unknown as Range;
        expect(readSelectionText(range, 'For each integer iii find the answer.')).toBe('For each integer $i$ find the answer.');
        expect(paragraph.querySelector('.MJX_Assistive_MathML')).not.toBeNull();
        paragraph.innerHTML = 'Evaluate <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span> now.';
        expect(readSelectionText(range, 'duplicate')).toBe('Evaluate $x^2$ now.');
        paragraph.innerHTML = 'Evaluate <math><mi>x</mi><annotation>duplicate</annotation></math> now.';
        expect(readSelectionText(range, 'duplicate')).toBe('Evaluate $x$ now.');
        paragraph.innerHTML = '<span class="MathJax_Preview"></span><span class="MathJax"><nobr>x</nobr></span>';
        expect(readSelectionText(range, 'xx')).toBe('');
        paragraph.innerHTML = 'Plain text';
        expect(readSelectionText(range, ' Plain text ')).toBe('Plain text');
        paragraph.innerHTML = 'Before <math>x</math> after';
        expect(readSelectionText({...range, cloneContents: () => document.createDocumentFragment()} as Range, ' Before ')).toBe('Before');
        paragraph.innerHTML = 'Evaluate <math></math> now';
        expect(readSelectionText(range, 'fallback')).toBe('Evaluate now');
        const math = paragraph.querySelector('math')!;
        expect(readSelectionText({commonAncestorContainer: math} as unknown as Range, 'x')).toBe('');
        expect(readSelectionText({commonAncestorContainer: null} as unknown as Range, ' word ')).toBe('word');
    });

    it('issue #492 allows prose crossing visible math but retains controls and local opt-outs', () => {
        const {document} = parseHTML(`<html><body><p>Read <span class="MathJax"><nobr aria-hidden="true">i</nobr><span class="MJX_Assistive_MathML"><math><mi>i</mi></math></span></span> now.</p></body></html>`);
        const paragraph = document.querySelector('p')!;
        const range = () => mockRange(paragraph.firstChild, paragraph.lastChild, {
            commonAncestor: paragraph, intersectingNodes: [...paragraph.querySelectorAll('*')],
        });
        const geometry = () => paragraph.querySelectorAll('*').forEach(element => {
            element.getClientRects = () => [{width: 10, height: 10}] as unknown as DOMRectList;
        });
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(false);
        paragraph.innerHTML = 'Read <math><mi>x</mi></math> now';
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(false);
        paragraph.innerHTML = 'Read <span class="MathJax"><svg><path/></svg><button>Run</button></span> now';
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(true);
        paragraph.innerHTML = 'Read <span translate="no"><span class="MathJax"><nobr aria-hidden="true">x</nobr></span></span> now';
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(true);
        paragraph.innerHTML = 'Read <span class="MathJax"><span contenteditable="true">x</span></span> now';
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(true);
        paragraph.innerHTML = 'Read <span class="MathJax"><span role="button">Run</span></span> now';
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(true);
        paragraph.innerHTML = 'Read <span aria-hidden="true">private</span> now';
        geometry();
        expect(shouldIgnoreSelection(range())).toBe(true);
    });

    it('classifies atomic and interactive elements as non-text selections', () => {
        for (const tagName of ['img', 'svg', 'video', 'canvas', 'button', 'input', 'textarea', 'select']) {
            expect(isSelectionExcludedTagName(tagName)).toBe(true);
        }
        expect(isSelectionExcludedTagName('code')).toBe(false);
        expect(isSelectionExcludedTagName('pre')).toBe(false);
        expect(isSelectionExcludedTagName('p')).toBe(false);
        expect(isSelectionExcludedTagName('span')).toBe(false);
    });

    it('忽略交互、可编辑和 FluentRead 自身 UI 内的选区', () => {
        expect(shouldIgnoreSelection(mockRange(
            new MockElement({tagName: 'IMG'}) as unknown as Node,
            new MockElement() as unknown as Node,
        ))).toBe(true);
        expect(shouldIgnoreSelection(mockRange(
            new MockElement({role: 'button'}) as unknown as Node,
            new MockElement() as unknown as Node,
        ))).toBe(true);
        expect(shouldIgnoreSelection(mockRange(
            new MockElement({isContentEditable: true}) as unknown as Node,
            new MockElement() as unknown as Node,
        ))).toBe(true);
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(new MockElement({attributes: {contenteditable: 'plaintext-only'}})),
            new MockElement() as unknown as Node,
        ))).toBe(true);
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(new MockElement({attributes: {contenteditable: 'false'}})),
            new MockElement({closestMatch: true}) as unknown as Node,
        ))).toBe(true);
    });

    it('安全处理缺失选区节点并支持文本节点共同祖先', () => {
        expect(shouldIgnoreSelection(mockRange(
            null,
            null,
            {commonAncestor: mockTextNode(null)},
        ))).toBe(false);

        const queryRoot = new MockElement();
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(queryRoot),
            mockTextNode(queryRoot),
            {commonAncestor: mockTextNode(queryRoot)},
        ))).toBe(false);
    });

    it('allows selection inside a body-level application shell but keeps local opt-outs protected', () => {
        const {document} = parseHTML(`
            <html><body>
                <div id="app" class="notranslate">
                    <main><p id="content">Readable application content.</p></main>
                </div>
            </body></html>
        `);
        const text = document.querySelector('#content')?.firstChild;
        const shell = document.querySelector('#app');
        if (!text) throw new Error('selection fixture text is missing');
        if (!shell) throw new Error('selection fixture shell is missing');
        Object.defineProperty(shell, 'getClientRects', {
            value: () => [{width: 640, height: 480}],
        });

        const range = {
            startContainer: text,
            endContainer: text,
            commonAncestorContainer: document,
            intersectsNode: (node: Node) => node === shell,
        } as unknown as Range;
        expect(shouldIgnoreSelection(range)).toBe(false);

        const protectedText = document.createTextNode('Protected local content.');
        const protectedRegion = document.createElement('span');
        protectedRegion.className = 'notranslate';
        protectedRegion.append(protectedText);
        document.querySelector('#content')?.append(' ', protectedRegion);
        Object.defineProperty(protectedRegion, 'getClientRects', {
            value: () => [{width: 160, height: 20}],
        });
        const protectedRange = {
            startContainer: text,
            startOffset: 0,
            endContainer: protectedText,
            endOffset: protectedText.length,
            commonAncestorContainer: document,
            intersectsNode: (node: Node) => node === shell || node === protectedRegion,
        } as unknown as Range;
        expect(shouldIgnoreSelection(protectedRange)).toBe(true);

        const button = document.createElement('button');
        button.textContent = 'Visible action';
        document.querySelector('#content')?.append(' ', button);
        Object.defineProperty(button, 'getClientRects', {
            value: () => [{width: 100, height: 24}],
        });
        const controlRange = {
            startContainer: text,
            startOffset: 0,
            endContainer: button.firstChild,
            endOffset: button.textContent!.length,
            commonAncestorContainer: document,
            intersectsNode: (node: Node) => node === shell || node === button,
        } as unknown as Range;
        expect(shouldIgnoreSelection(controlRange)).toBe(true);

        const shellRange = {
            startContainer: shell,
            endContainer: shell,
            commonAncestorContainer: shell,
            intersectsNode: (node: Node) => node === shell,
        } as unknown as Range;
        expect(shouldIgnoreSelection(shellRange)).toBe(true);
    });

    it('允许选区内部与 Range 相交但没有可见几何的排除元素', () => {
        const hiddenButton = new MockElement({tagName: 'BUTTON', contentRects: []});
        const root = new MockElement({descendants: [hiddenButton]});

        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(root),
            mockTextNode(root),
            {
                commonAncestor: root as unknown as Node,
                intersectingNodes: [hiddenButton as unknown as Node],
            },
        ))).toBe(false);
    });

    it('拒绝自身无盒子但内容具有可见几何的 display-contents 排除元素', () => {
        const displayContentsButton = new MockElement({
            tagName: 'BUTTON',
            contentRects: [{width: 36, height: 18}],
        });
        const root = new MockElement({descendants: [displayContentsButton]});

        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(root),
            mockTextNode(root),
            {
                commonAncestor: root as unknown as Node,
                intersectingNodes: [displayContentsButton as unknown as Node],
            },
        ))).toBe(true);
    });

    it('从 Document 和 ShadowRoot 公共祖先枚举实时排除元素', () => {
        for (const nodeType of [9, 11]) {
            const visibleButton = new MockElement({tagName: 'BUTTON', clientRects: [{width: 20, height: 16}]});
            const queryRoot = new MockElement({nodeType, descendants: [visibleButton]});
            const textParent = new MockElement();

            expect(shouldIgnoreSelection(mockRange(
                mockTextNode(textParent),
                mockTextNode(textParent),
                {
                    commonAncestor: queryRoot as unknown as Node,
                    intersectingNodes: [visibleButton as unknown as Node],
                },
            ))).toBe(true);
        }
    });

    it('只拒绝选区内部与 Range 相交且具有非零几何的排除元素', () => {
        const visibleButton = new MockElement({
            tagName: 'BUTTON',
            clientRects: [{width: 0, height: 0}, {width: 24, height: 18}],
        });
        const root = new MockElement({descendants: [visibleButton]});

        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(root),
            mockTextNode(root),
            {commonAncestor: root as unknown as Node},
        ))).toBe(false);
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(root),
            mockTextNode(root),
            {
                commonAncestor: root as unknown as Node,
                intersectingNodes: [visibleButton as unknown as Node],
            },
        ))).toBe(true);
    });

    it('选区端点位于排除元素内时保持严格拒绝，不受内部元素几何影响', () => {
        const button = new MockElement({tagName: 'BUTTON'});
        const hiddenRoot = new MockElement({descendants: [button]});

        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(button),
            mockTextNode(hiddenRoot),
            {
                commonAncestor: hiddenRoot as unknown as Node,
                intersectingNodes: [button as unknown as Node],
            },
        ))).toBe(true);
    });

    it('实时排除元素检查失败时 fail-open，避免破坏普通文本选择', () => {
        const textParent = new MockElement();
        const excluded = new MockElement({tagName: 'BUTTON', clientRects: [{width: 10, height: 10}]});
        const queryFailureRoot = new MockElement({querySelectorAllThrows: true});
        const intersectionRoot = new MockElement({descendants: [excluded]});
        const missingOwnerDocument = new MockElement({tagName: 'BUTTON'});
        const missingOwnerDocumentRoot = new MockElement({descendants: [missingOwnerDocument]});
        const geometryFailure = new MockElement({tagName: 'BUTTON', getClientRectsThrows: true});
        const geometryRoot = new MockElement({descendants: [geometryFailure]});
        const contentRangeFailures = (['create', 'select', 'rects'] as const).map(failure => (
            new MockElement({tagName: 'BUTTON', contentRangeFailure: failure})
        ));

        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(textParent),
            mockTextNode(textParent),
            {commonAncestor: queryFailureRoot as unknown as Node},
        ))).toBe(false);
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(textParent),
            mockTextNode(textParent),
            {
                commonAncestor: intersectionRoot as unknown as Node,
                intersectingNodes: [excluded as unknown as Node],
                intersectionFailureNodes: [excluded as unknown as Node],
            },
        ))).toBe(false);
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(textParent),
            mockTextNode(textParent),
            {
                commonAncestor: missingOwnerDocumentRoot as unknown as Node,
                intersectingNodes: [missingOwnerDocument as unknown as Node],
            },
        ))).toBe(false);
        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(textParent),
            mockTextNode(textParent),
            {
                commonAncestor: geometryRoot as unknown as Node,
                intersectingNodes: [geometryFailure as unknown as Node],
            },
        ))).toBe(false);
        for (const contentRangeFailure of contentRangeFailures) {
            const contentGeometryRoot = new MockElement({descendants: [contentRangeFailure]});
            expect(shouldIgnoreSelection(mockRange(
                mockTextNode(textParent),
                mockTextNode(textParent),
                {
                    commonAncestor: contentGeometryRoot as unknown as Node,
                    intersectingNodes: [contentRangeFailure as unknown as Node],
                },
            ))).toBe(false);
        }
    });

    it('单个排除元素检查失败时继续识别后续可见排除元素', () => {
        const geometryFailure = new MockElement({tagName: 'BUTTON', getClientRectsThrows: true});
        const visibleButton = new MockElement({tagName: 'BUTTON', clientRects: [{width: 20, height: 16}]});
        const root = new MockElement({descendants: [geometryFailure, visibleButton]});

        expect(shouldIgnoreSelection(mockRange(
            mockTextNode(root),
            mockTextNode(root),
            {
                commonAncestor: root as unknown as Node,
                intersectingNodes: [
                    geometryFailure as unknown as Node,
                    visibleButton as unknown as Node,
                ],
            },
        ))).toBe(true);
    });

    it('maps translation language codes to browser speech language codes', () => {
        expect(normalizeSpeechLanguage('zh-Hans')).toBe('zh-CN');
        expect(normalizeSpeechLanguage('zh-Hant-CN')).toBe('zh-TW');
        expect(normalizeSpeechLanguage('zh-HK')).toBe('zh-TW');
        expect(normalizeSpeechLanguage('en')).toBe('en-US');
        expect(normalizeSpeechLanguage('eng')).toBe('en-US');
        expect(normalizeSpeechLanguage('eng-GB')).toBe('en-GB');
        expect(normalizeSpeechLanguage('jpn')).toBe('ja-JP');
        expect(normalizeSpeechLanguage('zho-Hant')).toBe('zh-TW');
        expect(normalizeSpeechLanguage('zho-Hant-TW')).toBe('zh-TW');
        expect(normalizeSpeechLanguage('zho-Hans-CN')).toBe('zh-CN');
        const spanish = detectlang('Este programa permite traducir documentos y páginas de internet del español a otros idiomas.');
        expect(normalizeSpeechLanguage(spanish)).toBe('es-ES');
        expect(edgeTtsVoiceCandidatesForLanguage(normalizeSpeechLanguage(spanish))).toContain('es-ES-TristanMultilingualNeural');
        expect(normalizeSpeechLanguage(undefined, 'fr-FR')).toBe('fr-FR');
        expect(normalizeSpeechLanguage('auto', 'zh-CN')).toBe('zh-CN');
        expect(normalizeSpeechLanguage('und', 'zh-CN')).toBe('zh-CN');
        expect(normalizeSpeechLanguage('en-GB')).toBe('en-GB');
        expect(normalizeSpeechLanguage('invalid value')).toBe('en-US');
    });

    it('keeps uncertain Chinese script detectable while providing Mandarin speech for collected sentences', () => {
        const detected = detectlang('这是繁體中文測試，这是另一段简体中文。');
        expect(detected).toBe('cmn');
        expect(isSameLanguage(detected, 'zh-Hans')).toBe(false);
        expect(isSameLanguage(detected, 'zh-Hant')).toBe(false);
        for (const code of [detected, ' ZHO ', 'chi']) {
            const speechLanguage = normalizeSpeechLanguage(code);
            expect(speechLanguage).toBe('zh-CN');
            expect(edgeTtsVoiceCandidatesForLanguage(speechLanguage)).toContain('zh-CN-XiaoxiaoMultilingualNeural');
        }
        expect(edgeTtsVoiceCandidatesForLanguage(normalizeSpeechLanguage('zh-Hant'))[0]).toBe('zh-TW-YunJheMultilingualNeural');
    });

    it('uses stable Edge TTS voices instead of the first system voice', () => {
        expect(edgeTtsVoiceCandidatesForLanguage('en-US')[0]).toBe('en-US-AvaMultilingualNeural');
        expect(edgeTtsVoiceCandidatesForLanguage('en')[0]).toBe('en-US-AvaMultilingualNeural');
        expect(edgeTtsVoiceCandidatesForLanguage('zh-Hans')[0]).toBe('zh-CN-XiaoxiaoMultilingualNeural');
    });

    it('keeps valid configured voices first and falls back through the same language', () => {
        expect(normalizeSelectionTtsVoiceOrder([
            'en-US-JennyNeural',
            'not-a-voice',
            'en-US-JennyNeural',
            'zh-CN-XiaoyiNeural',
        ])).toEqual(['en-US-JennyNeural', 'zh-CN-XiaoyiNeural']);
        expect(edgeTtsVoiceCandidatesForLanguage('en-US', [
            'en-GB-SoniaNeural',
            'en-US-JennyNeural',
            'zh-CN-XiaoyiNeural',
        ])).toEqual([
            'en-US-JennyNeural',
            'en-US-AvaMultilingualNeural',
            'en-US-AriaNeural',
            'en-US-GuyNeural',
        ]);
        expect(normalizeSelectionTtsVoiceOrder('en-US-JennyNeural')).toEqual([]);
        expect(selectionTtsVoiceLocale('zh-CN-XiaoxiaoMultilingualNeural')).toBe('zh-CN');
    });

    it('does not expose malformed Edge TTS endpoint JSON in errors', async () => {
        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => {
                throw new SyntaxError('Unexpected token S in SENSITIVE_TTS_RESPONSE_SENTINEL');
            },
        });
        vi.stubGlobal('fetch', fetchMock);

        try {
            const error = await synthesizeEdgeTts('hello', 'en-US').catch(cause => cause);

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe('Edge TTS endpoint returned invalid JSON');
            expect((error as Error).message).not.toContain('SENSITIVE_TTS_RESPONSE_SENTINEL');
        } finally {
            vi.stubGlobal('fetch', originalFetch);
        }
    });

    it('continues to the next voice when Edge TTS rejects the first synthesis', async () => {
        const originalFetch = globalThis.fetch;
        const cancel = vi.fn(async () => {});
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ t: 'test-token', r: 'eastus' }) })
            .mockResolvedValueOnce({ ok: false, status: 503, body: {cancel} })
            .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
        vi.stubGlobal('fetch', fetchMock);

        try {
            const result = await synthesizeEdgeTts('hello', 'en-US', ['en-US-JennyNeural', 'en-US-AvaMultilingualNeural']);
            expect(result.voice).toBe('en-US-AvaMultilingualNeural');
            expect(cancel).toHaveBeenCalledOnce();
            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(String(fetchMock.mock.calls[1]?.[0])).toContain('.tts.speech.microsoft.com');
            expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('en-US-JennyNeural');
            expect(fetchMock.mock.calls[2]?.[1]?.body).toContain('en-US-AvaMultilingualNeural');
        } finally {
            vi.stubGlobal('fetch', originalFetch);
        }
    });

    it('aborts a pending Edge TTS synthesis instead of trying another voice', async () => {
        const originalFetch = globalThis.fetch;
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes('/apps/endpoint')) {
                return Promise.resolve({ok: true, json: async () => ({t: 'abort-test-token', r: 'eastus'})} as Response);
            }
            return new Promise<Response>((_resolve, reject) => {
                const rejectAbort = () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                };
                init?.signal?.addEventListener('abort', rejectAbort, {once: true});
                if (init?.signal?.aborted) rejectAbort();
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();

        try {
            const request = synthesizeEdgeTts('cancel me', 'en-US', [], controller.signal);
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
            controller.abort();

            await expect(request).rejects.toMatchObject({name: 'AbortError'});
            const synthesisCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('.tts.speech.microsoft.com'));
            expect(synthesisCalls).toHaveLength(1);
            expect(synthesisCalls[0]?.[1]?.signal).toBe(controller.signal);
        } finally {
            vi.stubGlobal('fetch', originalFetch);
        }
    });

    it('escapes selection text before putting it into SSML', () => {
        const ssml = buildEdgeTtsSsml('A < B & C', 'en-US-AvaMultilingualNeural');
        expect(ssml).toContain('A &lt; B &amp; C');
        expect(ssml).not.toContain('A < B & C');
    });

    it('resolves preset and custom selection shortcuts consistently', () => {
        expect(resolveConfiguredHotkey('Control', 'Ctrl+Shift+Y')).toBe('Control');
        expect(resolveConfiguredHotkey('custom', ' Ctrl+Shift+Y ')).toBe('Ctrl+Shift+Y');
        expect(resolveConfiguredHotkey('none', 'Ctrl+Shift+Y')).toBe('none');
        expect(resolveConfiguredHotkey('custom', ' ')).toBe('');

        const modifierCases = [
            ['Control', {key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false}],
            ['Alt', {key: 'Alt', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false}],
            ['Shift', {key: 'Shift', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false}],
        ] as const;
        for (const [hotkey, event] of modifierCases) {
            expect(matchesModifierOnlyHotkey(event, hotkey)).toBe(true);
            expect(matchesConfiguredHotkey(event as KeyboardEvent, hotkey)).toBe(true);
        }

        const controlWithExtraModifier = {key: 'Control', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false} as KeyboardEvent;
        expect(matchesConfiguredHotkey(controlWithExtraModifier, 'Control')).toBe(false);
        expect(matchesConfiguredHotkey(controlWithExtraModifier, 'none')).toBe(false);
    });

    it('matches custom selection combinations without accepting extra modifiers', () => {
        const shortcut = {key: 'y', code: 'KeyY', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false} as KeyboardEvent;
        const extraModifier = {...shortcut, altKey: true} as KeyboardEvent;
        expect(matchesConfiguredHotkey(shortcut, 'custom', 'Ctrl+Shift+Y')).toBe(true);
        expect(matchesConfiguredHotkey(extraModifier, 'custom', 'Ctrl+Shift+Y')).toBe(false);
        expect(matchesConfiguredHotkey(shortcut, 'none', 'Ctrl+Shift+Y')).toBe(false);
    });

    it('does not inspect selection geometry for unrelated keyboard input', () => {
        const hasCandidate = vi.fn(() => true);
        const unrelated = {key: 'x', code: 'KeyX', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false} as KeyboardEvent;
        const control = {key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false} as KeyboardEvent;

        expect(shouldClaimConfiguredHotkey(unrelated, 'Control', '', hasCandidate)).toBe(false);
        expect(hasCandidate).not.toHaveBeenCalled();
        expect(shouldClaimConfiguredHotkey(control, 'Control', '', hasCandidate)).toBe(true);
        expect(hasCandidate).toHaveBeenCalledTimes(1);
    });
});

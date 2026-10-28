import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {style: 1, to: 'zh-Hans'}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({ensureTranslationTruncationLayout: vi.fn()}));

import {
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    extractTranslationText,
    type TranslationCandidateCore,
} from '@/src/core/translation/public';
import {createTranslationCore} from './helpers/translationCore';
import {appendBilingualTranslation, materializeCandidate} from '@/src/features/full-page-translation/content/renderer';
import {isTranslationStateCandidateCurrent} from '@/src/features/full-page-translation/content/translationStability';
import {
    beginTranslation,
    getTranslationState,
    markTranslationComplete,
    restoreAllTranslations,
    restoreTranslation,
    setBilingualContent,
} from '@/src/features/full-page-translation/content/state';

function page(markup: string, computedColor?: (element: HTMLElement) => string) {
    const {document, window} = parseHTML(`<html><head><base href="https://example.org/article"></head><body><p id="owner">Read this explanation ${markup} with its linked details.</p></body></html>`);
    Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: (element: HTMLElement) => ({
            display: element.style.display || 'inline',
            visibility: element.style.visibility || 'visible',
            fontFamily: 'Arial',
            color: computedColor?.(element) ?? element.style.color ?? '',
        }),
    });
    // linkedom 将 contenteditable=false 也报告为可编辑；补齐浏览器的原生语义。
    document.querySelectorAll('[contenteditable="false"]').forEach(element =>
        Object.defineProperty(element, 'isContentEditable', {value: false}));
    vi.stubGlobal('document', document);
    vi.stubGlobal('Node', window.Node);
    return {document, window, owner: document.querySelector<HTMLElement>('#owner')!};
}

afterEach(() => {
    restoreAllTranslations();
    vi.unstubAllGlobals();
});

/** 功能层使用真实快照、renderer 与状态恢复；仅译文供应结果采用确定性文本。 */
function commitBilingual(owner: HTMLElement, core = createTranslationCore(), synthetic = false) {
    const sourceSlots = collectLiveTranslationTextSlots(owner, core.shouldStayOriginal);
    const attempt = beginTranslation(owner, 'bilingual', 'content', synthetic,
        extractTranslationText(owner, core.shouldStayOriginal), sourceSlots.map(slot => slot.node))!;
    expect(attempt).not.toBeNull();
    const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal,
        undefined, undefined, core.shouldOmitFromTranslation);
    const sources = snapshot.slots.map(slot => slot.source);
    const translations = sources.map(source => `译:${source}`);
    const html = applyTranslationsToSnapshot(snapshot, translations);
    expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
    const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
    setBilingualContent(owner, wrapper, {sources, translations, targetLanguage: 'zh-Hans', style: 1});
    return {wrapper, sources, snapshot, state: attempt.state};
}

describe('双语快照展示保护', () => {
    it('invalidates an earlier partial engagement owner when its missing action is mounted', () => {
        const {document} = page('');
        vi.stubGlobal('location', {href: 'https://x.com/NASA/status/1571977394151383042'});
        document.body.innerHTML = `<main><article><div id="engagement" style="display:block">
            <div data-engagement-action="retweet"><button><span>1万</span></button></div>
            <div data-engagement-action="like"><button><span>2.2万</span></button></div>
            <div><div data-engagement-action="bookmark"><button><span>430</span></button></div></div>
        </div></article></main>`;
        const core = createTranslationCore({url: new URL('https://x.com/NASA/status/1571977394151383042')});
        const bar = document.getElementById('engagement') as HTMLElement;
        const candidate = core.discover(document).find(item => item.element === bar || bar.contains(item.element));
        expect(candidate).toBeDefined();
        const owner = candidate!.element as HTMLElement;
        const {state} = commitBilingual(owner, core);
        expect(isTranslationStateCandidateCurrent(owner, state)).toBe(true);
        const reply = document.createElement('div');
        reply.setAttribute('data-engagement-action', 'reply');
        reply.innerHTML = '<a href="/compose/post"><span>318</span></a>';
        bar.insertBefore(reply, bar.firstChild);
        expect(isTranslationStateCandidateCurrent(owner, state)).toBe(false);
        expect(restoreTranslation(owner)).toBe(true);
        expect(bar.contains(reply)).toBe(true);
        expect(bar.querySelector('.fluent-read-bilingual-content')).toBeNull();
        expect(bar.textContent).toContain('318');
    });

    it('preserves the X engagement bar while translating and restoring neighboring post prose', () => {
        const {document} = page('');
        document.body.innerHTML = `<main><article id="post">
            <div id="body" data-testid="tweetText">The Moon shines above our planet.</div>
            <p id="nearby">The neighboring explanation remains readable.</p>
            <div id="engagement">
                <div data-engagement-action="reply"><a id="reply" href="/compose/post"><span>318</span></a></div>
                <div data-engagement-action="retweet"><button><span>1万</span></button></div>
                <div data-engagement-action="like"><button><span>2.2万</span></button></div>
                <div><div data-engagement-action="bookmark"><button><span>430</span></button></div></div>
            </div>
        </article></main>`;
        const core = createTranslationCore({url: new URL('https://x.com/NASA/status/1571977394151383042')});
        const bar = document.getElementById('engagement')!;
        const reply = document.getElementById('reply')!;
        let original = document.body.innerHTML;
        let originalBar = bar.outerHTML;
        const originalText = reply.firstChild!.firstChild!;
        const likeCount = bar.querySelector('[data-engagement-action="like"] span')!.firstChild as Text;
        for (let cycle = 0; cycle < 2; cycle += 1) {
            const candidates = core.discover(document);
            expect(candidates.some(candidate => candidate.element === bar || bar.contains(candidate.element))).toBe(false);
            const rendered: HTMLElement[] = [];
            const payloads: string[] = [];
            for (const candidate of candidates) {
                const materialized = materializeCandidate(candidate, false)!;
                const {sources} = commitBilingual(materialized.node, core, materialized.synthetic);
                rendered.push(materialized.node);
                payloads.push(...sources);
            }
            expect(payloads.join(' ')).toContain('The Moon shines above our planet.');
            expect(payloads.join(' ')).toContain('The neighboring explanation remains readable.');
            expect(payloads.join(' ')).not.toMatch(/318|1万|2\.[23]万|430/u);
            if (cycle === 0) {
                likeCount.data = '2.3万';
                original = original.replace('2.2万', '2.3万');
                originalBar = originalBar.replace('2.2万', '2.3万');
            }
            expect(bar.outerHTML).toBe(originalBar);
            expect(bar.querySelector('[data-engagement-action="like"] span')!.firstChild).toBe(likeCount);
            expect(reply.firstChild!.firstChild).toBe(originalText);
            for (const owner of rendered.reverse()) expect(restoreTranslation(owner)).toBe(true);
            expect(document.body.innerHTML).toBe(original);
            expect(reply.firstChild!.firstChild).toBe(originalText);
        }
    });

    it('omits GitHub pull-list author metadata from an ancestor translation without changing the original', () => {
        const {document} = page('');
        document.body.innerHTML = `<main><ul data-listview-component="items-list"><li>
            <h3><a id="title" data-testid="listitem-title-link" href="/owner/repo/pull/100">A readable pull request title</a></h3>
            <div id="description" class="container__W45oI6 description__mZjLFE"><span><span>#100</span></span>
                <span id="metadata" data-testid="timestamp-container"><span aria-hidden="true">·</span>
                    <a id="author" data-testid="author-filter-link" href="/owner/repo/pulls?author=ExampleUser">ExampleUser</a>
                    <span> opened </span><relative-time id="time">Oct 27, 2026</relative-time>
                </span><span id="association" data-testid="comment-author-association">Member</span>
                <span><button data-testid="checks-status-badge-button">1/1</button></span>
            </div>
        </li></ul></main>`;
        const core = createTranslationCore({url: new URL('https://github.com/owner/repo/pulls')});
        const title = document.querySelector<HTMLElement>('#title')!;
        const owner = document.querySelector<HTMLElement>('#description')!;
        const metadata = document.querySelector<HTMLElement>('#metadata')!;
        const author = document.querySelector<HTMLElement>('#author')!;
        const time = document.querySelector<HTMLElement>('#time')!;
        const authorText = author.firstChild!, timeText = time.firstChild!;
        const original = owner.innerHTML, originalMetadata = metadata.outerHTML;
        expect(core.shouldOmitFromTranslation(metadata)).toBe(true);
        expect(core.shouldStayOriginal(metadata)).toBe(true);
        expect(core.shouldOmitFromTranslation(title)).toBe(false);
        expect(core.resolve(title.firstChild)).toMatchObject({element: title, adapterId: 'github'});

        for (let cycle = 0; cycle < 2; cycle += 1) {
            const {wrapper, sources} = commitBilingual(owner, core);
            expect(sources.join(' ')).not.toContain('ExampleUser');
            expect(sources.join(' ')).not.toContain('Oct 27, 2026');
            expect(sources.join(' ')).toContain('Member');
            expect(wrapper.textContent).toContain('译:Member');
            expect(wrapper.querySelector('[data-testid="timestamp-container"]')).toBeNull();
            expect(wrapper.textContent).not.toContain('ExampleUser');
            expect(metadata.outerHTML).toBe(originalMetadata);
            expect(author.firstChild).toBe(authorText);
            expect(time.firstChild).toBe(timeText);
            expect(author.getAttribute('href')).toBe('/owner/repo/pulls?author=ExampleUser');
            expect(restoreTranslation(owner)).toBe(true);
            expect(owner.innerHTML).toBe(original);
            expect(author.firstChild).toBe(authorText);
            expect(time.firstChild).toBe(timeText);
        }
    });

    it.each(['slot="comment"', 'id="t1_nested-comment-rtjson-content"'])(
        'Reddit %s 表格内分段翻译和恢复保持原始结构、链接及代码', (marker) => {
            const {document} = page('');
            document.body.innerHTML = `<main><shreddit-comment><div ${marker}><table><thead><tr>
                <th><p id="heading-one">The first readable heading.</p><p id="heading-two">The second readable heading.</p></th></tr></thead>
                <tbody><tr><td id="mixed">A readable introduction with <a id="link" href="/guide">the original guide</a> and <code id="code">KEEP_CODE</code>.
                <p id="first">The first paragraph has its own context.</p><p id="second">The second paragraph has its own context.</p>
                A closing sentence with <strong>important details</strong>.</td></tr>
                <tr><td><ul><li><p id="list-one">The first list paragraph remains readable.</p><p id="list-two">The second list paragraph remains readable.</p></li></ul>
                <blockquote><p id="quote-one">The first quoted paragraph remains readable.</p><p id="quote-two">The second quoted paragraph remains readable.</p></blockquote></td></tr>
                <tr><td id="plain">A plain cell with an independent explanation.</td></tr><tr><td><p id="single">A single paragraph keeps its complete source.</p></td></tr></tbody></table>
                <div contenteditable="true" id="editor"><p>A private draft stays original.</p></div></div></shreddit-comment></main>`;
            const core = createTranslationCore({url: new URL('https://www.reddit.com/r/example/comments/123/topic/')});
            const original = document.body.innerHTML;
            const originals: Array<{node: ChildNode; value: string | null}> = [];
            const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
            while (walker.nextNode()) originals.push({node: walker.currentNode as ChildNode, value: walker.currentNode.nodeValue});
            const link = document.getElementById('link')!, code = document.getElementById('code')!;
            const expected = ['heading-one', 'heading-two', 'first', 'second', 'list-one', 'list-two',
                'quote-one', 'quote-two', 'plain', 'single'];
            for (let cycle = 0; cycle < 2; cycle += 1) {
                const candidates = core.discover(document);
                expect(candidates.filter(candidate => candidate.element.id === 'mixed' && candidate.nodes)).toHaveLength(2);
                for (const id of expected) expect(candidates.filter(candidate => candidate.element.id === id), id).toHaveLength(1);
                const active: HTMLElement[] = [];
                for (const candidate of candidates) {
                    const materialized = materializeCandidate(candidate, false)!;
                    expect(materialized).not.toBeNull();
                    const {wrapper, sources} = commitBilingual(materialized.node, core, materialized.synthetic);
                    active.push(materialized.node);
                    expect(sources.join(' ')).not.toContain('KEEP_CODE');
                    expect(wrapper.querySelector('[contenteditable]')).toBeNull();
                }
                expect(document.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(12);
                expect(document.getElementById('link')).toBe(link);
                expect(document.getElementById('code')).toBe(code);
                expect(link.getAttribute('href')).toBe('/guide');
                expect(code.textContent).toBe('KEEP_CODE');
                expect(document.querySelector('#editor .fluent-read-bilingual-content')).toBeNull();
                for (const id of expected) expect(document.querySelectorAll(`#${id} .fluent-read-bilingual-content`), id).toHaveLength(1);
                for (const owner of active.reverse()) expect(restoreTranslation(owner)).toBe(true);
                expect(document.body.innerHTML).toBe(original);
                expect(originals.every(entry => entry.node.isConnected && entry.node.nodeValue === entry.value)).toBe(true);
            }
        },
    );

    it.each(['slot="comment"', 'id="t1_wrapped-comment-rtjson-content"'])(
        'Reddit %s 的嵌套 DIV 正文两次翻译恢复保留所有文字与控件', (marker) => {
            const {document} = page('');
            document.body.innerHTML = `<main><shreddit-comment><div ${marker}><table><tbody><tr><td id="mixed">An opening explanation with <a id="wrapped-link" href="/guide">the original guide</a>.
                <div id="outer">The outer introduction provides useful background.
                    <div id="inner">The nested explanation keeps <code id="wrapped-code">DO_NOT_TRANSLATE</code> safe.</div>
                    <p id="inside">An inner paragraph remains independently readable.</p>
                    The outer conclusion remains readable.
                    <button id="wrapped-button"><div>A protected action remains unchanged.</div></button>
                    <div contenteditable="true" id="wrapped-editor"><p>A protected draft remains unchanged.</p></div>
                </div>
                <p id="peer">A peer paragraph remains independently readable.</p>
                A final explanation follows the paragraph.</td></tr></tbody></table></div></shreddit-comment></main>`;
            const core = createTranslationCore({url: new URL('https://www.reddit.com/r/example/comments/123/topic/')});
            const before = document.body.innerHTML;
            const ids = ['mixed', 'outer', 'inner', 'inside', 'peer', 'wrapped-link', 'wrapped-code', 'wrapped-button', 'wrapped-editor'];
            const nodes = ids.map(id => ({id, node: document.getElementById(id)!}));
            const protectedNodes = ['wrapped-code', 'wrapped-button', 'wrapped-editor'].map(id => ({node: document.getElementById(id)!, html: document.getElementById(id)!.outerHTML}));
            const originals: Array<{node: ChildNode; value: string | null}> = [];
            const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
            while (walker.nextNode()) originals.push({node: walker.currentNode as ChildNode, value: walker.currentNode.nodeValue});
            for (let cycle = 0; cycle < 2; cycle += 1) {
                const candidates = core.discover(document);
                expect(candidates).toHaveLength(7);
                const owners: HTMLElement[] = [], sources: string[] = [];
                for (const candidate of candidates) {
                    const materialized = materializeCandidate(candidate, false)!;
                    expect(materialized).not.toBeNull();
                    const result = commitBilingual(materialized.node, core, materialized.synthetic);
                    owners.push(materialized.node);
                    sources.push(result.sources.join(' '));
                }
                for (const expected of ['An opening explanation', 'the original guide', 'The outer introduction', 'The nested explanation',
                    'An inner paragraph', 'The outer conclusion', 'A peer paragraph', 'A final explanation']) {
                    expect(sources.filter(source => source.includes(expected)), expected).toHaveLength(1);
                }
                expect(sources.join(' ')).not.toMatch(/DO_NOT_TRANSLATE|A protected action|A protected draft/);
                expect(document.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(7);
                expect(nodes.every(({id, node}) => document.getElementById(id) === node)).toBe(true);
                expect(protectedNodes.every(({node, html}) => node.outerHTML === html)).toBe(true);
                expect(document.querySelector('#wrapped-editor .fluent-read-bilingual-content')).toBeNull();
                expect(document.querySelector('#wrapped-button .fluent-read-bilingual-content')).toBeNull();
                for (const owner of owners.reverse()) expect(restoreTranslation(owner)).toBe(true);
                expect(document.body.innerHTML).toBe(before);
                expect(originals.every(entry => entry.node.isConnected && entry.node.nodeValue === entry.value)).toBe(true);
            }
        },
    );

    it.each(['del', 's'])('%s 删除语义保留在最终译文中，两轮翻译恢复不改宿主节点或安全边界', (tag) => {
        const {owner} = page(`Was <${tag} id="deleted" class="host-deletion" onclick="unsafe()">ten</${tag}> ` +
            'now <strong id="replacement">eight</strong>. <code id="source-code">const value = 10;</code> ' +
            '<a id="source-link" href="https://example.org/guide" title="Guide">Read the guide</a> ' +
            '<a id="unsafe-link" href="javascript:unsafe()">Read the warning</a>');
        const sourceHTML = owner.innerHTML;
        const sourceChildren = [...owner.childNodes];
        const deleted = owner.querySelector<HTMLElement>('#deleted')!;
        const deletedText = deleted.firstChild;
        const replacement = owner.querySelector('#replacement')!;
        const link = owner.querySelector<HTMLAnchorElement>('#source-link')!;
        const linkText = link.firstChild;
        const code = owner.querySelector('#source-code')!;
        const codeText = code.firstChild;
        const originalDeletedHTML = deleted.outerHTML;
        let previousWrapper: HTMLElement | undefined;

        for (let cycle = 0; cycle < 2; cycle += 1) {
            const {wrapper, sources, snapshot} = commitBilingual(owner);
            const translatedDeleted = wrapper.querySelector(tag)!;
            expect(translatedDeleted, '最终 wrapper 必须保留删除语义，而不只是快照含有标签').not.toBeNull();
            expect(translatedDeleted.textContent).toBe('译:ten');
            expect(snapshot.clone.querySelector(tag)?.textContent).toBe('译:ten');
            expect(wrapper.querySelector('strong')?.textContent).toBe('译:eight');
            expect(translatedDeleted.hasAttribute('id')).toBe(false);
            expect(translatedDeleted.hasAttribute('class')).toBe(false);
            expect(wrapper.querySelector('[onclick]')).toBeNull();
            expect(wrapper.querySelector('a')?.getAttribute('href')).toBe('https://example.org/guide');
            expect(wrapper.querySelector('a')?.getAttribute('title')).toBe('Guide');
            expect(wrapper.querySelectorAll('a')[1]?.hasAttribute('href')).toBe(false);
            expect(sources).not.toContain('const value = 10;');
            expect(wrapper.querySelector('code')?.textContent).toBe('const value = 10;');
            expect(wrapper).not.toBe(previousWrapper);
            expect(owner.querySelector('#deleted')).toBe(deleted);
            expect(deleted.firstChild).toBe(deletedText);
            expect(deleted.outerHTML).toBe(originalDeletedHTML);
            expect(owner.querySelector('#replacement')).toBe(replacement);
            expect(owner.querySelector('#source-link')).toBe(link);
            expect(link.firstChild).toBe(linkText);
            expect(owner.querySelector('#source-code')).toBe(code);
            expect(code.firstChild).toBe(codeText);

            expect(restoreTranslation(owner)).toBe(true);
            expect(getTranslationState(owner)).toBeUndefined();
            expect(owner.innerHTML).toBe(sourceHTML);
            expect([...owner.childNodes]).toEqual(sourceChildren);
            sourceChildren.forEach((node, index) => expect(owner.childNodes[index]).toBe(node));
            expect(wrapper.isConnected).toBe(false);
            previousWrapper = wrapper;
        }
    });

    it.each(['del', 's'])('服务 HTML 的 %s 仅保留删除语义，不放行属性、脚本或危险链接', (tag) => {
        const {owner} = page('Original source remains unchanged.');
        const sourceHTML = owner.innerHTML;
        vi.stubGlobal('DOMParser', class FixtureDOMParser {
            parseFromString(source: string) {
                return parseHTML(`<html><body>${source}</body></html>`).document;
            }
        });
        const wrapper = appendBilingualTranslation(owner,
            `<${tag} onclick="unsafe()" class="host" style="position:fixed" cite="javascript:unsafe()" datetime="2026-10-26">` +
            `<a href="javascript:unsafe()">已撤回的建议</a><script>unsafe()</script></${tag}>`);
        const deleted = wrapper.querySelector(tag)!;
        expect(deleted.textContent).toBe('已撤回的建议');
        expect([...deleted.attributes]).toEqual([]);
        expect(deleted.querySelector('a')?.hasAttribute('href')).toBe(false);
        expect(wrapper.querySelector('script')).toBeNull();
        wrapper.remove();
        expect(owner.innerHTML).toBe(sourceHTML);
    });

    it.each([
        ['inline RGB', '<a href="https://example.org/guide" style="color:rgb(220, 38, 38)"><span>@steipete</span></a>', 'rgb(220, 38, 38)'],
        ['class', '<a href="https://example.org/guide" class="host-link"><span>@steipete</span></a>', 'rgb(31, 111, 235)'],
        ['inherited', '<span class="host-accent"><a href="https://example.org/guide"><span>@steipete</span></a></span>', 'rgb(22, 163, 74)'],
    ])('%s 链接按实时颜色保留嵌套文本，两轮翻译与恢复均不修改宿主', (_kind, markup, color) => {
        let sourceLink: HTMLAnchorElement | undefined;
        const {owner} = page(markup, element => element === sourceLink ? color : '');
        sourceLink = owner.querySelector<HTMLAnchorElement>('a')!;
        const originalHTML = owner.innerHTML;
        const originalChildren = [...owner.childNodes];
        const originalLinkText = sourceLink.firstChild;
        for (let cycle = 0; cycle < 2; cycle += 1) {
            const {wrapper} = commitBilingual(owner);
            const translatedLink = wrapper.querySelector<HTMLAnchorElement>('a')!;
            expect(translatedLink.style.color).toBe(color);
            expect(translatedLink.querySelector('span')?.textContent).toBe('@steipete');
            expect(translatedLink.getAttribute('href')).toBe('https://example.org/guide');
            expect(translatedLink.hasAttribute('class')).toBe(false);
            expect(restoreTranslation(owner)).toBe(true);
            expect(owner.innerHTML).toBe(originalHTML);
            expect([...owner.childNodes]).toEqual(originalChildren);
            expect(owner.querySelector('a')).toBe(sourceLink);
            expect(sourceLink.firstChild).toBe(originalLinkText);
        }
    });

    it.each(['unavailable', 'throws'] as const)('computed style %s 时保留来源链接的 inline color', (mode) => {
        const {owner, window} = page('<a href="https://example.org/guide" style="color:rgb(220, 38, 38)">@steipete</a>');
        Object.defineProperty(window, 'getComputedStyle', {
            configurable: true,
            value: mode === 'unavailable' ? undefined : () => {throw new Error('Style unavailable');},
        });
        const {wrapper} = commitBilingual(owner);
        expect(wrapper.querySelector<HTMLAnchorElement>('a')?.style.color).toBe('rgb(220, 38, 38)');
        expect(restoreTranslation(owner)).toBe(true);
    });

    it.each([true, false])('仅本地骨架放行链接 color，sourceSkeleton=%s 仍拒绝其他样式、class、事件和危险链接', (sourceSkeleton) => {
        const markup = '<a href="https://example.org/guide" title="Guide" class="host-link" onclick="alert(1)" ' +
            'style="color:rgb(220, 38, 38);background:red;position:fixed"><span class="host-text" style="color:blue">@steipete</span></a> ' +
            '<a href="javascript:alert(1)" style="color:rgb(220, 38, 38)">@unsafe</a>';
        const {owner} = page(markup);
        vi.stubGlobal('DOMParser', class FixtureDOMParser {
            parseFromString(source: string) {
                return parseHTML(`<html><body>${source}</body></html>`).document;
            }
        });
        const snapshot = createTranslationSourceSnapshot(owner);
        const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => `译:${slot.source}`));
        const wrapper = appendBilingualTranslation(owner, sourceSkeleton ? html : markup,
            sourceSkeleton ? {sourceSkeleton: snapshot.clone} : {});
        const [safeLink, unsafeLink] = [...wrapper.querySelectorAll<HTMLAnchorElement>('a')];
        expect(safeLink!.getAttribute('href')).toBe('https://example.org/guide');
        expect(safeLink!.getAttribute('title')).toBe('Guide');
        expect(safeLink!.style.color || '').toBe(sourceSkeleton ? 'rgb(220, 38, 38)' : '');
        expect(safeLink!.style.background || '').toBe('');
        expect(safeLink!.style.position || '').toBe('');
        expect(wrapper.querySelector('[class], [onclick]')).toBeNull();
        expect(safeLink!.querySelector('span')?.hasAttribute('style')).toBe(false);
        expect(unsafeLink!.hasAttribute('href')).toBe(false);
    });

    it.each([
        '<span hidden>EXCLUDED_SOURCE</span>',
        '<span inert>EXCLUDED_SOURCE</span>',
        '<span aria-hidden="true">EXCLUDED_SOURCE</span>',
        '<span class="sr-only">EXCLUDED_SOURCE</span>',
        '<span class="visually-hidden">EXCLUDED_SOURCE</span>',
        '<span style="display:none">EXCLUDED_SOURCE</span>',
        '<span style="visibility:hidden">EXCLUDED_SOURCE</span>',
        '<span style="visibility:collapse">EXCLUDED_SOURCE</span>',
        '<span translate="no" hidden>EXCLUDED_SOURCE</span>',
        '<span contenteditable="true">EXCLUDED_SOURCE</span>',
        '<span contenteditable="plaintext-only">EXCLUDED_SOURCE</span>',
        '<span contenteditable>EXCLUDED_SOURCE</span>',
        '<span translate="no" contenteditable="true">EXCLUDED_SOURCE</span>',
        '<textarea>EXCLUDED_SOURCE</textarea>',
        '<select><option>EXCLUDED_SOURCE</option></select>',
        '<canvas>EXCLUDED_SOURCE</canvas>',
        '<video>EXCLUDED_SOURCE</video>',
        '<svg><text>EXCLUDED_SOURCE</text></svg>',
        '<noscript>EXCLUDED_SOURCE</noscript>',
    ])('省略 %s 的双语副本，保留原节点与恢复后的结构', (markup) => {
        const {owner} = page(markup);
        const originalHTML = owner.innerHTML;
        const originalChildren = Array.from(owner.childNodes);
        for (let cycle = 0; cycle < 2; cycle += 1) {
            const snapshot = createTranslationSourceSnapshot(owner);
            expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain('EXCLUDED_SOURCE');
            const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => `译:${slot.source}`));
            const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
            expect(wrapper.textContent).toContain('译:Read this explanation');
            expect(wrapper.textContent).not.toContain('EXCLUDED_SOURCE');
            wrapper.remove();
            expect(owner.innerHTML).toBe(originalHTML);
            expect(Array.from(owner.childNodes)).toEqual(originalChildren);
        }
    });

    it('保留可见代码、禁译术语、contenteditable=false 和安全链接，不在宿主上复制事件', () => {
        const {owner} = page('<code>npm install</code> <span translate="no">OpenAI</span> <span contenteditable="false">A readable note</span> <a href="https://example.org/guide">the guide</a>');
        const anchor = owner.querySelector('a')!;
        const clicked = vi.fn();
        anchor.addEventListener('click', clicked);
        const snapshot = createTranslationSourceSnapshot(owner);
        expect(snapshot.slots.map(slot => slot.source)).toContain('A readable note');
        expect(snapshot.slots.map(slot => slot.source)).not.toContain('npm install');
        expect(snapshot.slots.map(slot => slot.source)).not.toContain('OpenAI');
        const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => `译:${slot.source}`));
        const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
        expect(wrapper.querySelector('code')?.textContent).toBe('npm install');
        expect(wrapper.textContent).toContain('OpenAI');
        expect(wrapper.textContent).toContain('译:A readable note');
        expect(wrapper.querySelector('a')?.getAttribute('href')).toBe('https://example.org/guide');
        wrapper.remove();
        expect(owner.querySelector('a')).toBe(anchor);
        anchor.dispatchEvent(new owner.ownerDocument.defaultView!.Event('click'));
        expect(clicked).toHaveBeenCalledOnce();
    });

    it('只翻译可读链接标题与周围正文，纯网址和域名保持原链接', () => {
        const {owner} = page('<a href="http://www.tubesnow.com/">http://www.tubesnow.com/</a> <a href="https://pub.dev/publishers/dash-overflow.net">dash-overflow.net</a> <a href="/guide">the guide</a>');
        const originalLinks = [...owner.querySelectorAll('a')];
        const snapshot = createTranslationSourceSnapshot(owner);
        const sources = snapshot.slots.map(slot => slot.source);
        expect(sources).toContain('Read this explanation');
        expect(sources).toContain('the guide');
        expect(sources).not.toContain('http://www.tubesnow.com/');
        expect(sources).not.toContain('dash-overflow.net');
        expect(collectLiveTranslationTextSlots(owner).map(slot => slot.source)).toEqual(sources);

        const html = applyTranslationsToSnapshot(snapshot, sources.map(source => `译:${source}`));
        const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
        expect([...wrapper.querySelectorAll('a')].map(link => link.textContent)).toEqual([
            'http://www.tubesnow.com/', 'dash-overflow.net', '译:the guide',
        ]);
        wrapper.remove();
        expect([...owner.querySelectorAll('a')]).toEqual(originalLinks);
    });

    it('依据实时隐藏状态重建副本，不因禁译祖先或已克隆的属性丢失漏出文字', () => {
        const {owner} = page('<span translate="no"><span id="changing">CURRENT_LITERAL</span></span>');
        const changing = owner.querySelector<HTMLElement>('#changing')!;
        expect(createTranslationSourceSnapshot(owner).clone.textContent).toContain('CURRENT_LITERAL');
        changing.hidden = true;
        expect(createTranslationSourceSnapshot(owner).clone.textContent).not.toContain('CURRENT_LITERAL');
        changing.hidden = false;
        expect(createTranslationSourceSnapshot(owner).clone.textContent).toContain('CURRENT_LITERAL');
    });

    it('可见公式保留 aria-hidden 排版子树，隐藏公式整体省略且辅助公式只保留一份', () => {
        const {owner} = page('<span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html" aria-hidden="true"><span>x</span></span></span> <span class="MathJax"><nobr aria-hidden="true">y</nobr><span class="MJX_Assistive_MathML"><math><mi>y</mi></math></span></span> <span class="katex" hidden><span class="katex-html">HIDDEN_FORMULA</span></span> <math><mi>z</mi></math>');
        const snapshot = createTranslationSourceSnapshot(owner);
        const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot => `译:${slot.source}`));
        const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
        expect(wrapper.querySelector('.katex')?.textContent).toBe('x');
        expect(wrapper.querySelector('.MathJax')?.textContent).toBe('y');
        expect(wrapper.querySelector('math')?.textContent).toBe('z');
        expect(wrapper.querySelectorAll('.katex')).toHaveLength(1);
        expect(wrapper.querySelector('.katex-mathml, .MJX_Assistive_MathML')).toBeNull();
        expect(wrapper.textContent).not.toContain('HIDDEN_FORMULA');
    });

    it('隐藏文字显示再隐藏后，三轮最终译文与恢复均采用当前可见内容且工件唯一', () => {
        const {owner} = page('<span id="changing" hidden>Revealed explanatory details</span>');
        const changing = owner.querySelector<HTMLElement>('#changing')!;
        const sourceNode = changing.firstChild;
        for (const hidden of [true, false, true]) {
            changing.hidden = hidden;
            const currentSourceHTML = owner.innerHTML;
            const result = commitBilingual(owner);
            expect(result.sources.includes('Revealed explanatory details')).toBe(!hidden);
            expect(result.wrapper.textContent?.includes('译:Revealed explanatory details')).toBe(!hidden);
            expect(owner.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
            expect(restoreTranslation(owner)).toBe(true);
            expect(result.state.controller.signal.aborted).toBe(true);
            expect(getTranslationState(owner)).toBeUndefined();
            expect(owner.innerHTML).toBe(currentSourceHTML);
            expect(changing.firstChild).toBe(sourceNode);
            expect(owner.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(0);
        }
    });

    it('只读表单值不进入双语副本，翻译后宿主更新的值在真实恢复时仍保留', () => {
        const {owner} = page('<textarea readonly>PRIVATE_READONLY_DRAFT</textarea><input readonly value="PRIVATE_READONLY_VALUE">');
        const textarea = owner.querySelector('textarea')!;
        const input = owner.querySelector('input')!;
        const result = commitBilingual(owner);
        expect(result.sources.join(' ')).not.toMatch(/PRIVATE_READONLY/u);
        expect(result.wrapper.textContent).not.toMatch(/PRIVATE_READONLY/u);
        expect(result.wrapper.querySelector('textarea,input')).toBeNull();
        textarea.value = 'HOST_UPDATED_DRAFT';
        input.value = 'HOST_UPDATED_VALUE';
        expect(restoreTranslation(owner)).toBe(true);
        expect(owner.querySelector('textarea')).toBe(textarea);
        expect(owner.querySelector('input')).toBe(input);
        expect(textarea.value).toBe('HOST_UPDATED_DRAFT');
        expect(input.value).toBe('HOST_UPDATED_VALUE');
        expect(owner.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(0);
    });

    it('SSR列表翻译后被hydrate替换，恢复不复活旧DOM，新任务行各自渲染并可恢复重译', () => {
        const {document} = page('');
        const href = 'https://github.com/kohya-ss/musubi-tuner/issues/1029';
        vi.stubGlobal('location', {href});
        document.body.innerHTML = '<main class="markdown-body"><ul id="list"><li>First server task.</li><li>Second server task.</li></ul></main>';
        const list = document.querySelector<HTMLElement>('#list')!;
        const core: TranslationCandidateCore = createTranslationCore({url: new URL(href)});
        const oldOwners = core.discover(list).map(candidate => candidate.element);
        expect(oldOwners).toHaveLength(2);
        oldOwners.forEach(owner => commitBilingual(owner, core));
        const fixture = parseHTML(readFileSync(new URL('./fixtures/translation-pages/github-task-list.html', import.meta.url), 'utf8')).document;
        list.innerHTML = fixture.querySelector('[data-testid="task-list"]')!.innerHTML;
        const hydratedHTML = list.innerHTML;
        const checkboxes = Array.from(list.querySelectorAll('input'));
        restoreAllTranslations();
        expect(list.innerHTML).toBe(hydratedHTML);
        expect(oldOwners.every(owner => !owner.isConnected && getTranslationState(owner) === undefined)).toBe(true);
        for (let cycle = 0; cycle < 2; cycle += 1) {
            const owners = core.discover(list).map(candidate => candidate.element);
            expect(owners.map(owner => owner.getAttribute('data-testid'))).toEqual([
                'task-content-0', 'task-content-1', 'task-content-2',
            ]);
            owners.forEach(owner => commitBilingual(owner, core));
            const wrappers = Array.from(list.querySelectorAll('.fluent-read-bilingual-content'));
            expect(wrappers).toHaveLength(3);
            expect(wrappers.map(wrapper => wrapper.parentElement)).toEqual(owners);
            expect(wrappers.every(wrapper => wrapper.textContent?.includes('译:'))).toBe(true);
            expect(list.querySelector('.fluent-read-bilingual-content .fluent-read-bilingual-content')).toBeNull();
            expect(list.querySelector('[data-testid="task-group"] > .fluent-read-bilingual-content')).toBeNull();
            restoreAllTranslations();
            expect(list.innerHTML).toBe(hydratedHTML);
            expect(Array.from(list.querySelectorAll('input'))).toEqual(checkboxes);
        }
    });
});

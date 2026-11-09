import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {isTagMetadataElement} from '@/src/core/translation/tagMetadata';
import {evaluateHardGuard} from '@/src/core/translation/dom';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {applyTranslationsToSnapshot, createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import {extractTranslationText, extractTranslationTextFromNodes, isTranslationTextNodeProtected} from '@/src/core/translation/text';
import {createTranslationMutationObserverOptions} from '@/src/features/full-page-translation/content/mutationObservation';

const tagExamples = [
    ['Discourse list', '<ul class="discourse-tags" id="tag"><li><a href="/tag/rate-limit/1"><span>rate-limit</span></a>,</li></ul>'],
    ['Discourse crawler', '<div class="discourse-tags" id="tag"><a href="/tag/rate-limit/1">rate-limit</a></div>'],
    ['Discourse link', '<a class="discourse-tag simple" id="tag" href="/tag/rate-limit/1"><span>rate-limit</span></a>'],
    ['Discourse label', '<span class="discourse-tag" id="tag">rate-limit</span>'],
    ['Discourse sidebar link', '<ul id="sidebar-section-content-tags"><li><a class="sidebar-section-link" id="tag" href="/tag/rate-limit/1"><span>rate-limit</span></a></li></ul>'],
    ['Discourse category badge', '<a class="badge-category__wrapper" id="tag" href="/c/rate-limit/7"><span class="badge-category">rate-limit</span></a>'],
    ['Discourse crawler category badge', '<a class="badge-wrapper" href="/c/rate-limit/7"><span class="badge-category" id="tag">rate-limit</span></a>'],
    ['standard tag', '<a id="tag" href="/topics/rate-limit" rel="tag">rate-limit</a>'],
    ['standard mixed tokens', '<a id="tag" href="/topics/rate-limit" rel="category TAG nofollow">rate-limit</a>'],
    ['question tag', '<a class="post-tag" id="tag" href="/questions/tagged/rate-limit">rate-limit</a>'],
    ['design system tag', '<a class="s-tag" id="tag" href="/questions/tagged/rate-limit">rate-limit</a>'],
    ['blog tag', '<a class="tag" id="tag" href="/topics/rate-limit">rate-limit</a>'],
    ['post metadata', '<div class="post-tags"><a id="tag" href="/topics/rate-limit">rate-limit</a></div>'],
    ['entry metadata', '<div class="entry-tags"><a id="tag" href="/topics/rate-limit">rate-limit</a></div>'],
    ['tag list', '<ul class="tag-list"><li><a id="tag" href="/topics/rate-limit">rate-limit</a></li></ul>'],
    ['tags list', '<ul class="tags"><li><a id="tag" href="/topics/rate-limit">rate-limit</a></li></ul>'],
] as const;

const sourceFor = (core: TranslationCandidateCore, document: Document) => core.discover(document).map(candidate =>
    extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal)).join('\n');

describe('topic tag metadata shared boundaries', () => {
    it.each(tagExamples)('%s stays out of candidates, hover resolution and extracted requests', (_name, html) => {
        const {document} = parseHTML(`<html><body><main><h1 id="title">How translation helps readers follow a discussion</h1>${html}<p id="body">The explanation around these topic labels remains readable and translatable.</p></main></body></html>`);
        const tag = document.getElementById('tag')!;
        expect(isTagMetadataElement(tag)).toBe(true);
        for (const scope of ['content', 'all'] as const) {
            // No site adapters: these boundaries must work on any host, even with site rules disabled.
            const core = new TranslationCandidateCore({url: new URL('https://unlisted.example/article'), scope, adapters: []});
            expect(evaluateHardGuard(tag)).toMatchObject({prune: true, reason: 'topic-tag'});
            const text = tag.querySelector('span')?.firstChild ?? tag.firstChild!;
            expect(core.resolve(text), scope).toBeNull();
            expect(sourceFor(core, document), scope).not.toContain('rate-limit');
            expect(sourceFor(core, document), scope).toContain('How translation helps readers');
            expect(sourceFor(core, document), scope).toContain('The explanation around these topic labels');
            expect(extractTranslationText(document.body), scope).not.toContain('rate-limit');
        }
    });

    it.each([
        '<p class="tag" id="ordinary">An article about tag systems remains readable.</p>',
        '<a id="ordinary" href="/tag/rate-limit">A readable explanation linked from an article.</a>',
        '<a id="ordinary" href="/tag/rate-limit" class="tagline">A readable tagline about the product.</a>',
        '<a id="ordinary" href="/tag/rate-limit" class="discourse-tag-example">An explanation of forum tags.</a>',
        '<a id="ordinary" href="/tag/rate-limit" rel="tagged">A readable article about organizing topics.</a>',
        '<a id="ordinary" class="tag">A label without tag navigation stays translatable.</a>',
        '<a id="ordinary" class="badge-wrapper" href="/article/1">A linked explanation about organizing categories.</a>',
        '<a id="ordinary" class="badge-category__wrapper-preview" href="/article/1">A linked explanation about organizing categories.</a>',
        '<div class="tags"><p id="ordinary">An explanatory paragraph inside a tags section.</p></div>',
        '<div class="tags"><article><p><a href="/article/1" id="ordinary">A readable article link inside a tag archive.</a></p></article></div>',
        '<article class="post-tag"><p id="ordinary">An entire article must not be excluded by a tag class.</p></article>',
    ])('does not infer metadata from ordinary prose, partial classes or a tag URL: %s', html => {
        const markup = html.startsWith('<a') ? `<p>Read this explanation: ${html}</p>` : html;
        const {document} = parseHTML(`<html><body>${markup}</body></html>`);
        const ordinary = document.getElementById('ordinary')!;
        const core = new TranslationCandidateCore({adapters: []});
        expect(isTagMetadataElement(ordinary)).toBe(false);
        expect(evaluateHardGuard(ordinary).prune).toBe(false);
        expect(sourceFor(core, document)).toContain(ordinary.textContent);
    });

    it('preserves inline tag markup while translating surrounding prose and leaving the source untouched', () => {
        const {document} = parseHTML('<html><body><p id="body">The discussion explains <a id="tag" href="/tag/image-generation" rel="tag"><span>image-generation</span></a> with readable examples.</p></body></html>');
        const body = document.getElementById('body')!;
        const original = body.innerHTML;
        const tag = document.getElementById('tag')!.outerHTML;
        const snapshot = createTranslationSourceSnapshot(body);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain('image-generation');
        const output = parseHTML(`<html><body>${applyTranslationsToSnapshot(snapshot, snapshot.slots.map(() => '正文译文'))}</body></html>`).document;
        expect(output.getElementById('tag')!.outerHTML).toBe(tag);
        expect(output.body.textContent).toContain('正文译文');
        expect(body.innerHTML).toBe(original);
    });

    it('uses current class and rel semantics after insertion, attribute changes and remount', () => {
        const {document} = parseHTML('<html><body><main><p id="body">A readable explanation keeps its original source stable.</p></main></body></html>');
        const core = new TranslationCandidateCore({adapters: []});
        document.querySelector('main')!.insertAdjacentHTML('beforeend', '<a id="dynamic" href="/topics/creative">creative</a>');
        const tag = document.getElementById('dynamic')!;
        expect(sourceFor(core, document)).toContain('creative');
        tag.setAttribute('rel', 'tag');
        expect(sourceFor(core, document)).not.toContain('creative');
        expect(isTranslationTextNodeProtected(tag.firstChild as Text)).toBe(true);
        tag.removeAttribute('rel');
        expect(sourceFor(core, document)).toContain('creative');
        tag.className = 'discourse-tag';
        expect(sourceFor(core, document)).not.toContain('creative');
        document.body.innerHTML = document.body.innerHTML;
        expect(core.resolve(document.getElementById('dynamic')!.firstChild)).toBeNull();
        expect(sourceFor(core, document)).not.toContain('creative');
        document.getElementById('dynamic')!.className = '';
        expect(sourceFor(core, document)).toContain('creative');
        expect(createTranslationMutationObserverOptions([]).attributeFilter).toEqual(expect.arrayContaining(['class', 'href', 'rel']));
    });

    it('inherits tag protection across an open shadow root without excluding adjacent prose', () => {
        const {document} = parseHTML('<html><body><div id="host" class="discourse-tag"></div><p id="body">The neighboring paragraph remains readable.</p></body></html>');
        const host = document.getElementById('host')!;
        const shadow = host.attachShadow({mode: 'open'});
        shadow.innerHTML = '<span id="label">shadow-tag</span>';
        const label = shadow.querySelector('span')!;
        const core = new TranslationCandidateCore({adapters: []});
        expect(evaluateHardGuard(label)).toMatchObject({prune: true, reason: 'topic-tag'});
        expect(isTranslationTextNodeProtected(label.firstChild as Text)).toBe(true);
        expect(core.resolve(label.firstChild)).toBeNull();
        expect(sourceFor(core, document)).toContain('The neighboring paragraph');
    });
});

import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createDeclarativeAdapter} from '@/src/core/translation/adapters/declarative';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import type {AdapterContext} from '@/src/core/translation/types';

const url = new URL('https://example.test');
const freshContext = (): AdapterContext => ({url, closestSelectorMisses: new WeakMap()});
function fixture(depth = 48) {
    return parseHTML(`<html><body><main>${'<div>'.repeat(depth)}<p id="leaf">This readable source sentence must remain unchanged.</p>${'</div>'.repeat(depth)}</main></body></html>`);
}

describe('inspect-local declarative ancestor misses', () => {
    it('reuses wide prune/target misses across ancestors and protection misses from root to leaf', () => {
        const {document} = fixture();
        const prune = Array.from({length: 20}, (_, i) => `.missing-prune-${i}`);
        const target = Array.from({length: 20}, (_, i) => `.missing-target-${i}`);
        const protect = ['.missing-protected'];
        const adapter = createDeclarativeAdapter({id: 'cost', hosts: ['example.test'],
            prune: [{selector: prune, reason: 'exclude'}],
            targets: [{selector: target, match: 'closest', reason: 'missing'}, {selector: '#leaf', reason: 'source'}],
            keepOriginal: [{selector: protect, reason: 'protect'}]});
        const selectors = new Set([prune.join(','), target.join(','), protect.join(',')]);
        const calls: string[] = [];
        document.querySelectorAll('*').forEach(element => {
            const original = element.closest.bind(element);
            vi.spyOn(element, 'closest').mockImplementation(selector => {
                if (selectors.has(selector)) calls.push(selector);
                return original(selector);
            });
        });
        const core = new TranslationCandidateCore({url, adapters: [adapter]});
        const leaf = document.querySelector('#leaf')!;
        expect(core.inspect(leaf).candidate?.element).toBe(leaf);
        // Baseline repeats closest on ~52 ancestors per selector; this assertion must fail before patch.
        expect(calls.filter(x => x === prune.join(','))).toHaveLength(1);
        expect(calls.filter(x => x === target.join(','))).toHaveLength(1);
        expect(calls.filter(x => x === protect.join(','))).toHaveLength(1);
        expect(leaf.textContent).toBe('This readable source sentence must remain unchanged.');
    });

    it('creates a fresh cache after a scope mutation and recovers after restoring the scope', () => {
        const {document} = fixture(8);
        const leaf = document.querySelector('#leaf')!;
        const parent = leaf.parentElement!;
        const adapter = createDeclarativeAdapter({id: 'scope', hosts: ['example.test'],
            prune: [{selector: '.excluded', reason: 'exclude'}], targets: [{selector: '#leaf', reason: 'source'}]});
        const core = new TranslationCandidateCore({url, adapters: [adapter]});
        const source = leaf.innerHTML;
        expect(core.inspect(leaf).candidate?.element).toBe(leaf);
        parent.classList.add('excluded');
        expect(core.inspect(leaf).candidate).toBeNull();
        parent.classList.remove('excluded');
        expect(core.inspect(leaf).candidate?.element).toBe(leaf);
        expect(leaf.innerHTML).toBe(source);
    });

    it('a parent miss still checks a matching child and preserves target identity', () => {
        const {document} = parseHTML('<html><body><main><p id="child" class="target">Readable target source.</p></main></body></html>');
        const parent = document.querySelector('main')!;
        const child = document.querySelector('#child')!;
        const adapter = createDeclarativeAdapter({id: 'target', hosts: ['example.test'],
            targets: [{selector: '.target', match: 'closest', reason: 'target', atomic: false, splitOnBr: true}]});
        const context = freshContext();
        expect(adapter.decide(parent, context)).toEqual({kind: 'pass'});
        expect(adapter.decide(child, context)).toMatchObject({kind: 'force-target', target: child, atomic: false, splitOnBr: true});
    });

    it('query exceptions do not become ancestor misses', () => {
        const {document} = parseHTML('<html><body><section class="excluded"><p id="leaf">Source.</p></section></body></html>');
        const leaf = document.querySelector('#leaf')!;
        const parent = leaf.parentElement!;
        const adapter = createDeclarativeAdapter({id: 'error', hosts: ['example.test'], prune: [{selector: '.excluded', reason: 'exclude'}]});
        vi.spyOn(leaf, 'closest').mockImplementation(() => {throw new Error('host query failure');});
        const context = freshContext();
        expect(adapter.decide(leaf, context)).toEqual({kind: 'pass'});
        expect(adapter.decide(parent, context)).toMatchObject({kind: 'prune-subtree'});
    });

    it.each([':scope:not(.scope)', '.\\73 cope', '&'])('does not infer ancestor misses from scope-dependent or escaped syntax %s', selector => {
        const {document} = parseHTML('<html><body><section><p id="leaf">Source.</p></section></body></html>');
        const leaf = document.querySelector('#leaf')!;
        const parent = leaf.parentElement!;
        // Control syntax acceptance so the regression tests the cache guard, independent of linkedom support.
        const create = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
            const element = create(tagName);
            vi.spyOn(element, 'matches').mockReturnValue(false);
            return element;
        });
        const adapter = createDeclarativeAdapter({id: 'syntax', hosts: ['example.test'], prune: [{selector, reason: 'exclude'}]});
        vi.spyOn(leaf, 'closest').mockReturnValue(null);
        const parentQuery = vi.spyOn(parent, 'closest').mockReturnValue(parent);
        const context = freshContext();
        expect(adapter.decide(leaf, context)).toEqual({kind: 'pass'});
        expect(adapter.decide(parent, context)).toMatchObject({kind: 'prune-subtree'});
        expect(parentQuery).toHaveBeenCalledOnce();
    });

    it('light-DOM misses do not leak through a shadow root to its composed host', () => {
        const {document} = parseHTML('<html><body><section id="host" class="excluded"></section></body></html>');
        const host = document.querySelector('#host')!;
        const shadow = host.attachShadow({mode: 'open'});
        shadow.innerHTML = '<p id="leaf">Readable shadow source.</p>';
        const leaf = shadow.querySelector('#leaf')!;
        const adapter = createDeclarativeAdapter({id: 'shadow', hosts: ['example.test'], prune: [{selector: '.excluded', reason: 'exclude'}]});
        const context = freshContext();
        expect(adapter.decide(leaf, context)).toEqual({kind: 'pass'});
        expect(adapter.decide(host, context)).toMatchObject({kind: 'prune-subtree'});
        expect(new TranslationCandidateCore({url, adapters: [adapter]}).inspect(leaf).candidate).toBeNull();
    });

    it.each([
        ['legacy', '<div class="ReposListItem-module__TopicsList"><span id="label">literal-topic</span></div>'],
        ['current', '<ul data-listview-component="items-list"><li><div class="TopicsList__XBoKUv"><span id="label">literal-topic</span></div></li></ul>'],
    ])('retains actual GitHub %s modal/exclude/source boundaries across repeated inspect calls', (_variant, topicMarkup) => {
        const {document} = parseHTML(`<html><body><div class="markdown-body"><p id="source">Readable GitHub source with an <a href="/original">original link</a>.</p></div><div role="dialog"><p id="modal">Search modal source.</p></div>${topicMarkup}</body></html>`);
        const core = new TranslationCandidateCore({url: new URL('https://github.com/example/repo'), adapters: compileSiteRulePack(builtinSiteRulePack)});
        const source = document.querySelector('#source')!;
        const before = document.body.innerHTML;
        expect(core.inspect(source).candidate?.element).toBe(source);
        expect(core.inspect(document.querySelector('#modal')!).candidate).toBeNull();
        expect(core.inspect(document.querySelector('#label')!).candidate).toBeNull();
        source.parentElement!.setAttribute('role', 'dialog');
        expect(core.inspect(source).candidate).toBeNull();
        source.parentElement!.removeAttribute('role');
        expect(core.inspect(source).candidate?.element).toBe(source);
        expect(document.body.innerHTML).toBe(before);
    });

    it('deduplicates repeated selectors shared across protect, exclude, and omit rules', () => {
        const {document} = parseHTML('<html><body><div class="markdown-body"><p id="source">Readable GitHub paragraph.</p></div></body></html>');
        const source = document.querySelector('#source')!;
        const adapters = compileSiteRulePack(builtinSiteRulePack).filter(adapter => adapter.id === 'github');
        const github = adapters[0]!;
        const observedSelectors: string[] = [];
        const originalClosest = source.closest.bind(source);
        vi.spyOn(source, 'closest').mockImplementation(selector => {
            observedSelectors.push(selector);
            return originalClosest(selector);
        });
        expect(github.shouldStayOriginal?.(source, {url: new URL('https://github.com/example/repo')})).toBe(false);
        expect(observedSelectors).toHaveLength(1);
        const parts = observedSelectors[0]!.split(',');
        expect(parts.length).toBe(new Set(parts).size);
    });

    it('reuses multi-level cached ancestor misses without re-walking outer containers with closest()', () => {
        const {document} = parseHTML('<html><body><main id="root"><section id="mid"><div id="inner"><span id="leaf">Readable text.</span></div></section></main></body></html>');
        const root = document.querySelector('#root')!;
        const mid = document.querySelector('#mid')!;
        const inner = document.querySelector('#inner')!;
        const leaf = document.querySelector('#leaf')!;
        const adapter = createDeclarativeAdapter({
            id: 'multi-level-miss', hosts: ['example.test'],
            prune: [{selector: ['.excluded', '.excluded'], reason: 'exclude'}],
        });
        const context = freshContext();
        expect(adapter.decide(root, context)).toEqual({kind: 'pass'});
        const leafClosest = vi.spyOn(leaf, 'closest');
        expect(adapter.decide(leaf, context)).toEqual({kind: 'pass'});
        expect(leafClosest).not.toHaveBeenCalled();

        // A matching intermediate node below the cached-miss ancestor must still hit via matches().
        inner.classList.add('excluded');
        const hitContext = freshContext();
        expect(adapter.decide(root, hitContext)).toEqual({kind: 'pass'});
        const hitClosest = vi.spyOn(leaf, 'closest');
        expect(adapter.decide(leaf, hitContext)).toEqual({kind: 'prune-subtree', reason: 'exclude'});
        expect(hitClosest).not.toHaveBeenCalled();
        expect(mid.isConnected).toBe(true);
    });

    it('shares synchronous read cache across discover, nested epochs, and explicit invalidation', () => {
        const {document} = parseHTML('<html><body><main id="host"><div><p id="a">First readable sentence.</p><p id="b">Second readable sentence.</p></div></main></body></html>');
        const host = document.querySelector('#host')!;
        const first = document.querySelector('#a')!;
        const second = document.querySelector('#b')!;
        const adapter = createDeclarativeAdapter({
            id: 'epoch-cache', hosts: ['example.test'],
            prune: [{selector: '.blocked', reason: 'blocked'}],
            keepOriginal: [{selector: '.kept', reason: 'kept'}],
            targets: [{selector: 'p', match: 'closest', reason: 'paragraph', atomic: true}],
        });
        const core = new TranslationCandidateCore({url, adapters: [adapter]});
        expect(core.getSynchronousTextProtectionCache()).toBeUndefined();

        const closestSpy = vi.spyOn(first, 'closest');
        const discovered = core.discover(document);
        expect(discovered.map(candidate => candidate.element)).toEqual([first, second]);
        expect(closestSpy).not.toHaveBeenCalled();
        expect(core.getSynchronousTextProtectionCache()).toBeUndefined();

        core.withSynchronousReadCache(invalidate => {
            const outerCache = core.getSynchronousTextProtectionCache();
            expect(outerCache).toBeDefined();
            // Nested epochs inherit the active cache without discarding ancestor misses.
            core.withSynchronousReadCache(() => {
                expect(core.getSynchronousTextProtectionCache()).toBe(outerCache);
                expect(core.inspect(first).candidate?.element).toBe(first);
                expect(core.inspect(second, {protectedElement: second}).candidate?.element).toBe(second);
            });
            expect(core.getSynchronousTextProtectionCache()).toBe(outerCache);
            host.classList.add('blocked');
            invalidate();
            expect(core.getSynchronousTextProtectionCache()).not.toBe(outerCache);
            expect(core.inspect(first).candidate).toBeNull();
            expect(core.inspect(second, {protectedElement: second}).candidate).toBeNull();
        });
        expect(core.getSynchronousTextProtectionCache()).toBeUndefined();
    });
});

import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {isXGifLabel, withXGifLabelProtection} from '@/src/core/site-adaptation/xGifLabel';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack, composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';
import type {TranslationSiteAdapter} from '@/src/core/translation/types';

const url = new URL('https://x.com/NASA/status/1571977394151383042');
const context = {url};
const settings = {enabled: true, disabledRuleIds: [] as string[], custom: {version: 1 as const, rules: []}};
function fixture() {
    const {document} = parseHTML(`<html><body><main><article><p id="body">This post explains GIF formats.</p>
        <div id="player"><video src="https://video.twimg.com/tweet_video/test.mp4" poster="https://pbs.twimg.com/tweet_video_thumb/test"></video>
          <div data-slot="xds-context-menu-trigger"><img src="https://pbs.twimg.com/tweet_video_thumb/test?format=webp">
            <div><div id="label" class="bg-black-80 text-on-color text-subtext3 font-bold">GIF</div></div>
            <p id="subtitle">A readable video subtitle.</p></div></div>
        </article></main></body></html>`);
    const get = (selector: string) => document.querySelector(selector)! as HTMLElement;
    return {document, get, label: get('#label'), player: get('#player')};
}

describe('X GIF overlay labels', () => {
    it('protects exactly the native GIF label in discovery, hover and ancestor snapshots', () => {
        const {document, get, label, player} = fixture();
        const adapters = composeSiteAdapters(builtinSiteRulePack, settings);
        const core = new TranslationCandidateCore({url, adapters});
        const x = adapters.find(adapter => adapter.id === 'x')!;
        expect(isXGifLabel(label)).toBe(true);
        expect(x.decide(label, context)).toEqual({kind: 'prune-subtree', reason: 'x:gif-label'});
        expect(core.shouldStayOriginal(label)).toBe(true);
        expect(core.resolve(label.firstChild)).toBeNull();
        expect(core.discover(player).some(candidate => candidate.element === label)).toBe(false);
        const snapshot = createTranslationSourceSnapshot(player, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toContain('A readable video subtitle.');
        expect(snapshot.slots.map(slot => slot.source).join(' ')).not.toContain('GIF');
        expect(snapshot.clone.querySelector('#label')?.textContent).toBe('GIF');
        expect(core.shouldStayOriginal(get('#body'))).toBe(false);
        expect(document.body.textContent).toContain('This post explains GIF formats.');
    });

    it.each(['LIVE', 'gif', 'GIF description', 'GIF 1', 'G I F', '', '动图'])('keeps nonexact label %s eligible', text => {
        const {label} = fixture(); label.textContent = text;
        expect(isXGifLabel(label)).toBe(false);
    });

    it('ignores a translated owned copy when reading native label text', () => {
        const {document, label} = fixture(); const copy = document.createElement('span');
        copy.setAttribute('data-fr-translation-owned', 'true'); copy.innerHTML = '<b>译文</b>';
        label.appendChild(copy);
        expect(isXGifLabel(label)).toBe(true); expect(isXGifLabel(copy)).toBe(false);
        label.firstChild!.textContent = 'LIVE'; expect(isXGifLabel(label)).toBe(false);
    });

    it.each(['a', 'span', 'button', 'br'])('does not protect native %s markup', tag => {
        const {document, label} = fixture(); label.appendChild(document.createElement(tag));
        expect(isXGifLabel(label)).toBe(false);
    });

    it.each(['role', 'tabindex', 'contenteditable', 'href', 'aria-label', 'aria-labelledby', 'dir'])(
        'does not protect semantic attribute %s', attr => {
            const {label} = fixture(); label.setAttribute(attr, attr === 'dir' ? 'auto' : 'x');
            expect(isXGifLabel(label)).toBe(false);
        });

    it('rejects non-text nodes and reading text inside a dir=auto ancestor', () => {
        const {document, label} = fixture(); label.appendChild(document.createComment('native'));
        expect(isXGifLabel(label)).toBe(false); label.lastChild!.remove();
        label.parentElement!.setAttribute('dir', 'auto'); expect(isXGifLabel(label)).toBe(false);
    });

    it.each(['not-label', 'no-video', 'nested-video', 'other-video', 'no-image', 'other-image', 'foreign-player', 'outside-main'])('%s is not a GIF label', mode => {
        const {document, label, player} = fixture(); const video = player.querySelector('video')!;
        const image = player.querySelector('img')!, overlay = label.closest('[data-slot]')!;
        if (mode === 'not-label') label.classList.remove('font-bold');
        if (mode === 'no-video') video.remove();
        if (mode === 'nested-video') {const div = document.createElement('div'); video.replaceWith(div); div.appendChild(video);}
        if (mode === 'other-video') video.setAttribute('src', 'https://video.twimg.com/ext_tw_video/test.mp4');
        if (mode === 'no-image') {image.remove(); video.removeAttribute('poster');}
        if (mode === 'other-image') {image.setAttribute('src', 'https://example.com/tweet_video_thumb/test'); video.removeAttribute('poster');}
        if (mode === 'foreign-player') overlay.removeAttribute('data-slot');
        if (mode === 'outside-main') document.body.appendChild(player);
        expect(isXGifLabel(label)).toBe(false);
    });

    it('rechecks native label text and media references after a change', () => {
        const {label, player} = fixture();
        expect(isXGifLabel(label)).toBe(true);
        label.textContent = 'LIVE'; expect(isXGifLabel(label)).toBe(false);
        label.textContent = ' GIF '; expect(isXGifLabel(label)).toBe(true);
        player.querySelector('video')!.removeAttribute('src'); expect(isXGifLabel(label)).toBe(false);
        player.querySelector('video')!.setAttribute('src', 'https://video.twimg.com/tweet_video/new.mp4');
        expect(isXGifLabel(label)).toBe(true);
        player.querySelector('img')!.removeAttribute('src'); expect(isXGifLabel(label)).toBe(true);
        player.querySelector('video')!.removeAttribute('poster'); expect(isXGifLabel(label)).toBe(false);
    });

    it('uses a later matching video poster before scanning the overlay', () => {
        const {document, label, player} = fixture();
        player.querySelector('video')!.removeAttribute('poster');
        const overlay = label.closest('[data-slot]')!;
        overlay.querySelector('img')!.removeAttribute('src');
        const later = document.createElement('video');
        later.setAttribute('src', 'https://video.twimg.com/tweet_video/second.mp4');
        later.setAttribute('poster', 'https://pbs.twimg.com/tweet_video_thumb/second');
        player.appendChild(later);
        const firstChild = Object.getOwnPropertyDescriptor(overlay, 'firstChild');
        Object.defineProperty(overlay, 'firstChild', {configurable: true, get() {throw new Error('poster must short-circuit');}});
        try {expect(isXGifLabel(label)).toBe(true);} finally {
            if (firstChild) Object.defineProperty(overlay, 'firstChild', firstChild);
            else Reflect.deleteProperty(overlay, 'firstChild');
        }
    });

    it('scans the overlay once even when many videos need a thumbnail', () => {
        const {document, label, player} = fixture();
        player.querySelector('video')!.removeAttribute('poster');
        const image = player.querySelector('img')!; image.removeAttribute('src');
        const read = vi.spyOn(image, 'getAttribute');
        for (let i = 0; i < 100; i += 1) {
            const video = document.createElement('video');
            video.setAttribute('src', 'https://video.twimg.com/tweet_video/test.mp4');
            player.appendChild(video);
        }
        expect(isXGifLabel(label)).toBe(false);
        expect(read.mock.calls.filter(([name]) => name === 'src')).toHaveLength(1);
    });

    it('finds a nested thumbnail after backtracking from an unrelated sibling subtree', () => {
        const {document, label, player} = fixture();
        player.querySelector('video')!.removeAttribute('poster');
        const overlay = label.closest('[data-slot]')!, image = overlay.querySelector('img')!;
        const unrelated = document.createElement('div'); unrelated.innerHTML = '<span><b>No image here</b></span>';
        const nest = document.createElement('div'), inner = document.createElement('span');
        inner.appendChild(image); nest.appendChild(inner);
        overlay.replaceChildren(label, unrelated, nest);
        expect(isXGifLabel(label)).toBe(true);
        image.removeAttribute('src'); expect(isXGifLabel(label)).toBe(false);
    });

    it('bounds direct player nodes and fails closed once the scan exceeds its budget', () => {
        const {document, label, player} = fixture();
        const video = player.querySelector('video')!, overlay = label.closest('[data-slot]')!;
        video.removeAttribute('poster'); player.replaceChildren(video, overlay);
        for (let i = 0; i < 510; i += 1) player.appendChild(document.createElement('i'));
        expect(isXGifLabel(label)).toBe(true);
        player.appendChild(document.createElement('i'));
        expect(isXGifLabel(label)).toBe(false);
    });

    it('bounds the overlay traversal and accepts a thumbnail only within the budget', () => {
        const {document, label, player} = fixture();
        player.querySelector('video')!.removeAttribute('poster');
        const overlay = label.closest('[data-slot]')!;
        const image = overlay.querySelector('img')!;
        overlay.replaceChildren(label);
        for (let i = 0; i < 4093; i += 1) overlay.appendChild(document.createElement('i'));
        overlay.appendChild(image);
        expect(isXGifLabel(label)).toBe(true);
        image.before(document.createElement('i'));
        expect(isXGifLabel(label)).toBe(false);
    });

    it('fails closed for abnormally large label node lists and text', () => {
        const {document, label} = fixture();
        label.textContent = 'GIF';
        for (let i = 0; i < 64; i += 1) label.appendChild(document.createTextNode(''));
        expect(isXGifLabel(label)).toBe(false);
        label.textContent = `${' '.repeat(64)}GIF`;
        expect(isXGifLabel(label)).toBe(false);
    });

    it('bounds ancestor traversal and respects owned ancestors', () => {
        const {document, label} = fixture();
        const parent = label.parentElement!;
        let anchor = label;
        for (let i = 0; i < 100; i += 1) {
            const inner = document.createElement('div');
            anchor.replaceWith(inner); inner.appendChild(anchor); anchor = inner;
        }
        expect(isXGifLabel(label)).toBe(true);
        parent.setAttribute('data-fr-translation-owned', 'true');
        expect(isXGifLabel(label)).toBe(false);
        parent.removeAttribute('data-fr-translation-owned');
        for (let i = 0; i < 40; i += 1) {
            const inner = document.createElement('div');
            anchor.replaceWith(inner); inner.appendChild(anchor); anchor = inner;
        }
        expect(isXGifLabel(label)).toBe(false);
    });

    it('does not grant the capability to foreign hosts, disabled rules or same-ID custom replacements', () => {
        const {label} = fixture();
        const builtin = composeSiteAdapters(builtinSiteRulePack, settings);
        const adapter = builtin.find(value => value.id === 'x')!;
        expect(adapter.decide(label, {url: new URL('https://x.com.example.test/')} ).kind).not.toBe('prune-subtree');
        expect(adapter.shouldStayOriginal!(label, {url: new URL('https://example.org/')})).toBe(false);
        expect(composeSiteAdapters(builtinSiteRulePack, {...settings, disabledRuleIds: ['x']}).some(value => value.id === 'x')).toBe(false);
        const custom = {version: 1 as const, rules: [{id: 'x', name: 'custom', match: {hosts: ['x.com']}, mode: 'augment' as const}]};
        const replacement = composeSiteAdapters(builtinSiteRulePack, {...settings, custom}).find(value => value.id === 'x')!;
        expect(replacement.decide(label, context).kind).not.toBe('prune-subtree');
        expect(replacement.shouldStayOriginal!(label, context)).toBe(false);
        const direct = compileSiteRulePack(builtinSiteRulePack).find(value => value.id === 'x')!;
        expect(direct.decide(label, context).kind).not.toBe('prune-subtree');
    });

    it('keeps adapter fallbacks and descriptors for ordinary nodes', () => {
        const {label, get} = fixture();
        const raw: TranslationSiteAdapter = {id: 'x', matches: () => true,
            decide: () => ({kind: 'pass'}), get observedAttributes() {return null;}};
        const wrapped = withXGifLabelProtection(raw);
        expect(wrapped.observedAttributes).toBeNull();
        expect(wrapped.decide(get('#body'), context).kind).toBe('pass');
        expect(wrapped.shouldStayOriginal!(get('#body'), context)).toBe(false);
        expect(wrapped.shouldStayOriginal!(label, context)).toBe(true);
    });
});

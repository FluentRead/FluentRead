import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {xVideoChildListRescanRoot} from '@/src/core/site-adaptation/xVideoMutationRescan';
import {composeSiteAdapters} from '@/src/core/site-adaptation/compiler';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {TranslationCandidateCore} from '@/src/core/translation/engine';

const settings = {enabled: true, disabledRuleIds: [] as string[], custom: {version: 1 as const, rules: []}};
const context = {url: new URL('https://x.com/NASA/status/1')};
const thumbnail = 'https://pbs.twimg.com/tweet_video_thumb/one';
function page() {
    const document = parseHTML(`<html><body><main><article><div id="player"><video></video>
        <div id="overlay" data-slot="xds-context-menu-trigger"><div class="x-avatar"><img alt="@person"></div>
        <img id="thumbnail" src="${thumbnail}"><div id="ordinary">Play</div></div>
        </div></article></main></body></html>`).document as unknown as Document;
    const get = (selector: string) => document.querySelector(selector)!;
    return {document, player: get('#player'), overlay: get('#overlay'), avatar: get('.x-avatar'),
        image: get('.x-avatar img'), thumbnail: get('#thumbnail'), video: get('video'), ordinary: get('#ordinary')};
}
function mutation(target: Node, added: readonly Node[] = [], removed: readonly Node[] = [], type = 'childList'): MutationRecord {
    return {type, target, addedNodes: added, removedNodes: removed} as unknown as MutationRecord;
}

describe('X video identity mutation rescan boundaries', () => {
    it('rescans only the original overlay when avatar or thumbnail identity is added or removed', () => {
        const {overlay, avatar, image, thumbnail} = page();
        expect(xVideoChildListRescanRoot(mutation(avatar, [], [image]))).toBe(overlay);
        expect(xVideoChildListRescanRoot(mutation(avatar, [image]))).toBe(overlay);
        expect(xVideoChildListRescanRoot(mutation(overlay, [], [thumbnail]))).toBe(overlay);
        expect(xVideoChildListRescanRoot(mutation(overlay, [thumbnail]))).toBe(overlay);
    });

    it('recognizes an identity image inside an added or removed subtree', () => {
        const {document, overlay} = page();
        const container = document.createElement('span'); container.innerHTML = '<span><img alt="@person"></span>';
        expect(xVideoChildListRescanRoot(mutation(overlay, [], [container]))).toBe(overlay);
        expect(xVideoChildListRescanRoot(mutation(overlay, [container]))).toBe(overlay);
    });

    it('rescans an attached sibling overlay when the player direct video is added or removed', () => {
        const {player, overlay, video, document} = page();
        video.remove();
        expect(xVideoChildListRescanRoot(mutation(player, [], [video]))).toBe(overlay);
        expect(xVideoChildListRescanRoot(mutation(player, [video]))).toBe(overlay);
        const container = document.createElement('span'); container.appendChild(video);
        expect(xVideoChildListRescanRoot(mutation(player, [container]))).toBeNull();
    });

    it('does not promote ordinary controls, unrelated images or nested video mutations', () => {
        const {document, overlay, ordinary} = page();
        const span = document.createElement('span'); span.textContent = 'Play';
        const image = document.createElement('img'); image.alt = 'Landscape'; image.src = 'https://example.test/image.png';
        const video = document.createElement('video');
        expect(xVideoChildListRescanRoot(mutation(ordinary, [span]))).toBeNull();
        expect(xVideoChildListRescanRoot(mutation(overlay, [image]))).toBeNull();
        expect(xVideoChildListRescanRoot(mutation(overlay, [video]))).toBeNull();
        expect(xVideoChildListRescanRoot(mutation(overlay, [], []))).toBeNull();
    });

    it('rejects ordinary text changes before reading any target ancestors', () => {
        const {document, ordinary} = page();
        const matches = vi.spyOn(ordinary, 'matches');
        expect(xVideoChildListRescanRoot(mutation(ordinary, [document.createTextNode('Play')]))).toBeNull();
        expect(matches).not.toHaveBeenCalled();
    });

    it('never walks irrelevant changed subtrees outside an overlay', () => {
        const {document, player} = page();
        const unrelated = document.createElement('div');
        Object.defineProperty(unrelated, 'firstChild', {get: () => {throw new Error('unrelated subtree was traversed');}});
        expect(xVideoChildListRescanRoot(mutation(player, [unrelated]))).toBeNull();
    });

    it('ignores extension-owned targets and changed subtrees', () => {
        const {document, overlay, image, ordinary} = page();
        const owned = document.createElement('span'); owned.setAttribute('data-fr-translation-owned', 'true');
        owned.appendChild(image); overlay.appendChild(owned);
        expect(xVideoChildListRescanRoot(mutation(owned, [image]))).toBeNull();
        expect(xVideoChildListRescanRoot(mutation(ordinary, [owned]))).toBeNull();
    });

    it('rejects missing, disconnected, unrelated, non-element and ambiguous roots', () => {
        const {document, player, overlay, image, video} = page();
        expect(xVideoChildListRescanRoot(mutation(overlay, [image], [], 'attributes'))).toBeNull();
        expect(xVideoChildListRescanRoot(mutation(document.createTextNode('text'), [image]))).toBeNull();
        const detached = document.createElement('div'); expect(xVideoChildListRescanRoot(mutation(detached, [image]))).toBeNull();
        document.body.appendChild(player); expect(xVideoChildListRescanRoot(mutation(overlay, [image]))).toBeNull();
        document.querySelector('main article')!.appendChild(player);
        const second = document.createElement('div'); second.setAttribute('data-slot', 'xds-context-menu-trigger'); player.appendChild(second);
        expect(xVideoChildListRescanRoot(mutation(overlay, [image]))).toBeNull();
        expect(xVideoChildListRescanRoot(mutation(player, [], [video]))).toBeNull();
        second.remove(); video.remove(); expect(xVideoChildListRescanRoot(mutation(overlay, [image]))).toBeNull();
    });

    it('rejects oversized changed lists, changed trees and player children', () => {
        const {document, overlay, image, player} = page();
        const many = Array.from({length: 513}, () => document.createElement('i'));
        expect(xVideoChildListRescanRoot(mutation(overlay, many))).toBeNull();
        const tree = document.createElement('div'); tree.append(...many); tree.appendChild(image);
        expect(xVideoChildListRescanRoot(mutation(overlay, [tree]))).toBeNull();
        overlay.prepend(image);
        for (let i = 0; i < 513; i++) player.appendChild(document.createElement('i'));
        expect(xVideoChildListRescanRoot(mutation(overlay, [image]))).toBeNull();
    });

    it('rejects an overdeep overlay ancestry', () => {
        const {document, overlay, image} = page();
        let node = document.createElement('div'); overlay.appendChild(node);
        for (let i = 0; i < 130; i++) {const child = document.createElement('div'); node.appendChild(child); node = child;}
        expect(xVideoChildListRescanRoot(mutation(node, [image]))).toBeNull();
    });

    it('does not grant the capability to disabled, custom, all-scope or other-host adapters', () => {
        const {overlay, image} = page();
        const built = composeSiteAdapters(builtinSiteRulePack, settings).find(adapter => adapter.id === 'x')!;
        const record = mutation(overlay, [image]);
        expect(built.childListRescanRoot!(record, context)).toBe(overlay);
        expect(built.childListRescanRoot!(record, {url: new URL('https://x.com.example.test/')})).toBeNull();
        expect(composeSiteAdapters(builtinSiteRulePack, {...settings, disabledRuleIds: ['x']}).some(adapter => adapter.id === 'x')).toBe(false);
        const custom = {version: 1 as const, rules: [{id: 'x', name: 'custom', match: {hosts: ['x.com']}, mode: 'augment' as const}]};
        const replaced = composeSiteAdapters(builtinSiteRulePack, {...settings, custom}).find(adapter => adapter.id === 'x')!;
        expect(replaced.childListRescanRoot).toBeUndefined();
        const all = new TranslationCandidateCore({url: context.url, scope: 'all', adapters: [built]});
        expect(all.adapters).toHaveLength(0);
    });
});

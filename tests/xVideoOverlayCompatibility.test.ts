import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {createTranslationSourceSnapshot, extractTranslationText} from '@/src/core/translation/public';
import {createTranslationCore} from './helpers/translationCore';

// The two author overlays and player structure are reduced from the saved public X DOM.
// The subtitle and lookalike nodes exercise boundaries that were not present in that capture.
const NAME = 'abril⁷ is seeing BTS';
const SECOND_NAME = 'Another creator';
const LOOKALIKE = 'Similar overlay stays translatable';
const PROSE = 'Name in prose remains readable';
const OWN_DIR = 'A subtitle with its own direction';
const author = (id: string, avatar: string | null = '@abrillrossa', label = NAME, targetAttributes = '') => `<span class="inline-flex min-w-0 items-center gap-1 align-middle">
    <span class="inline-flex size-[13px] shrink-0"><div class="x-avatar" aria-hidden="true">${avatar === null ? '' : `<img alt="${avatar}">`}</div></span>
    <div class="flex items-center gap-1 min-w-0"><span class="flex max-w-full min-w-0 shrink-0 items-center gap-1">
        <div id="${id}" class="max-w-full text-subtext2 font-normal text-white line-clamp-1 break-all min-w-0" ${targetAttributes}>${label}</div>
    </span></div>
</span>`;

function page() {
    return parseHTML(`<html><body><main><article>
        <div id="post" dir="auto" class="whitespace-pre-wrap">The moon shines above our planet.</div>
        <div id="media"><video></video><div id="player" data-slot="xds-context-menu-trigger">
            <button><svg data-icon="icon-player-play"></svg></button>
            <a href="/abrillrossa/status/1315055146645110784">${author('author-link')}</a>
            <div>00:00${author('author-time', '@abrillrossa', SECOND_NAME)}</div>
            <div id="subtitle" class="text-white line-clamp-1">A sentence spoken in the video.</div>
            ${author('no-avatar', null, LOOKALIKE)}
            ${author('no-handle', 'A generic picture', 'Another descriptive caption')}
            ${author('own-dir', '@abrillrossa', OWN_DIR, 'dir="auto"')}
            <div dir="auto">${author('prose-name', '@abrillrossa', PROSE)}</div>
        </div></div>
        <div><div><video></video></div><div id="other-menu" data-slot="xds-context-menu-trigger">${author('other-menu-name')}</div></div>
        <div><div data-slot="xds-context-menu-trigger"><video></video>${author('nested-video-name')}</div></div>
        ${author('outside-player')}
    </article></main></body></html>`).document as unknown as Document;
}

describe('X embedded video overlay compatibility', () => {
    it.each(['x.com', 'www.x.com', 'twitter.com', 'mobile.twitter.com'])(
        'protects only the two player author labels on %s', hostname => {
            const document = page();
            const url = new URL(`https://${hostname}/NASA/status/1571977394151383042`);
            const adapter = compileSiteRulePack({version: 1, rules: [builtinSiteRulePack.rules.find(rule => rule.id === 'x')!]})[0]!;
            const decision = (id: string) => adapter.decide(document.getElementById(id)!, {url}).kind;
            expect(decision('author-link')).toBe('prune-subtree');
            expect(decision('author-time')).toBe('prune-subtree');
            for (const id of ['post', 'player', 'subtitle', 'no-avatar', 'no-handle', 'own-dir', 'prose-name', 'other-menu-name', 'nested-video-name', 'outside-player']) {
                expect(decision(id), id).toBe('pass');
            }
            const core = createTranslationCore({url});
            const player = document.getElementById('player')!;
            const names = ['author-link', 'author-time'].map(id => document.getElementById(id)!);
            const candidates = core.discover(document);
            for (const name of names) {
                expect(candidates.some(candidate => name === candidate.element || name.contains(candidate.element))).toBe(false);
                expect(core.resolve(name.firstChild)).toBeNull();
            }
            const snapshot = createTranslationSourceSnapshot(player, core.shouldStayOriginal,
                undefined, undefined, core.shouldOmitFromTranslation);
            const sources = snapshot.slots.map(slot => slot.source).join(' ');
            expect(sources).toContain('A sentence spoken in the video.');
            expect(sources).toContain(LOOKALIKE);
            expect(sources).toContain(PROSE);
            expect(sources).toContain(OWN_DIR);
            expect(sources).not.toContain(NAME);
            expect(sources).not.toContain(SECOND_NAME);
            expect(snapshot.clone.textContent).toContain(NAME);
            expect(snapshot.clone.textContent).toContain(SECOND_NAME);
            expect(extractTranslationText(player, core.shouldStayOriginal)).toContain(LOOKALIKE);
            expect(extractTranslationText(player, core.shouldStayOriginal)).not.toContain(NAME);
            expect(extractTranslationText(player, core.shouldStayOriginal)).not.toContain(SECOND_NAME);
            expect(extractTranslationText(document.getElementById('post')!, core.shouldStayOriginal))
                .toBe('The moon shines above our planet.');
        },
    );

    it('does not apply the site rule to a lookalike host', () => {
        const document = page();
        const url = new URL('https://x.com.example.test/NASA/status/1571977394151383042');
        const core = createTranslationCore({url});
        const authorName = document.getElementById('author-link')!;
        expect(core.shouldStayOriginal(authorName)).toBe(false);
    });

    it('keeps author protection as player controls change and rechecks the media and avatar structure', () => {
        const document = page();
        const url = new URL('https://x.com/NASA/status/1571977394151383042');
        const core = createTranslationCore({url});
        const name = document.getElementById('author-link')!;
        const avatar = name.closest('a')!.querySelector('img')!;
        const playerIcon = document.querySelector('#player svg')!;
        expect(core.shouldStayOriginal(name)).toBe(true);
        name.textContent = 'A renamed video author';
        playerIcon.setAttribute('data-icon', 'icon-player-pause');
        expect(core.shouldStayOriginal(name)).toBe(true);
        playerIcon.remove();
        expect(core.shouldStayOriginal(name)).toBe(true);
        avatar.removeAttribute('alt');
        expect(core.shouldStayOriginal(name)).toBe(false);
        avatar.setAttribute('alt', '@renamed');
        expect(core.shouldStayOriginal(name)).toBe(true);
        document.querySelector('#media > video')!.remove();
        expect(core.shouldStayOriginal(name)).toBe(false);
    });
});

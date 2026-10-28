/**
 * @file tests/xModernSiteAdaptationRegression.test.ts
 * Functional regression: X public, signed-out DOM captured 2026-10-08 without extension.
 * Exact main timeline-entry and related-user section subtrees are embedded below;
 * main/list/aside reconnect their semantic ancestors. No provider or browser is invoked.
 * Evidence: /private/tmp/fluentread-release-performance-20261008/x-public/page.html
 * Page SHA-256: b35d7859953b694bc354195b44dcbae55c4ebe1f0eb55acde6a12e5bf3b4152a
 * oEmbed confirms the original English post; the user's duplicate result is unconfirmed.
 */
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack, getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import {validateSelectors} from '@/src/core/site-adaptation/schema';
import {createTranslationMutationObserverOptions} from '@/src/features/full-page-translation/content/mutationObservation';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {
    applyTranslationsToSnapshot, createTranslationSourceSnapshot,
    extractTranslationText, extractTranslationTextFromNodes, getTranslationCandidateKey,
    hasDistinctTranslation, normalizeTranslationText,
} from '@/src/core/translation/public';
import {createTranslationCore} from './helpers/translationCore';
import type {SiteRulePack} from '@/src/core/site-adaptation/types';
import type {TranslationCandidate, TranslationScope} from '@/src/core/translation/public';

const PUBLIC_SUBTREES = [
    "<main class=\"border-normal mx-auto flex h-auto w-full max-w-[602px] min-w-0 flex-col sm:border-x\" style=\"--sticky-header-height: 53px;\">",
    "<ul>",
    "<li>",
    "<div tabindex=\"-1\" class=\"outline-blue-500 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 px-horizontal py-vertical border-b border-gray-100\" data-timeline-entry=\"\">",
    "<!--$-->",
    "<article class=\"flex flex-col gap-1\">",
    "<div class=\"flex flex-col gap-2\">",
    "<div class=\"flex flex-col gap-3\">",
    "<div class=\"flex gap-2\">",
    "<div class=\"relative flex w-10 shrink-0 justify-center self-stretch\">",
    "<div class=\"relative z-10\">",
    "<a class=\"x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 max-w-full rounded-none active\" id=\"base-ui-_r_g_\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<div class=\"x-avatar rounded-full size-10 transition duration-200 hover:brightness-90\">",
    "<img alt=\"@thsottiaux\" class=\"size-full object-cover\" draggable=\"false\" loading=\"lazy\" srcset=\"https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg 1x, https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_x96.jpg 2x, https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_reasonably_small.jpg 3x\" src=\"https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg\">",
    "</div>",
    "</a>",
    "</div>",
    "</div>",
    "<div class=\"flex min-w-0 flex-1 flex-col\">",
    "<div class=\"flex items-start justify-between gap-2\">",
    "<div class=\"overflow-hidden flex flex-col items-start min-w-0\" id=\"base-ui-_r_i_\">",
    "<span class=\"flex max-w-full min-w-0 shrink-0 items-center gap-1\">",
    "<a class=\"rounded-xs x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 hover:underline max-w-full min-w-0 active\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<div class=\"max-w-full text-body font-bold text-primary line-clamp-1 break-all min-w-0\">Tibo</div>",
    "</a>",
    "<div class=\"max-w-full text-body font-normal text-primary flex shrink-0 items-center gap-1\">",
    "<span aria-label=\"认证账号\" class=\"flex cursor-pointer items-center\" role=\"button\" tabindex=\"0\" data-base-ui-click-trigger=\"\" id=\"base-ui-_r_k_\" aria-haspopup=\"dialog\" aria-expanded=\"false\">",
    "<svg fill=\"none\" viewBox=\"0 0 24 24\" display=\"flex\" role=\"img\" width=\"1em\" height=\"1em\" aria-hidden=\"true\" aria-label=\"认证账号\" class=\"size-[1em] shrink-0\">",
    "<use href=\"#icon-verified-premium-color\" />",
    "</svg>",
    "</span>",
    "</div>",
    "</span>",
    "<span class=\"flex min-w-0 items-center gap-2\">",
    "<a class=\"rounded-xs x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 max-w-full min-w-0 active\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<span class=\"max-w-full text-body font-normal text-secondary line-clamp-1 [font-feature-settings:'ss01']\">@thsottiaux</span>",
    "</a>",
    "</span>",
    "</div>",
    "<div class=\"flex shrink-0 items-center gap-1 whitespace-nowrap\">",
    "<button data-slot=\"xds-menu-trigger\" tabindex=\"0\" aria-haspopup=\"menu\" aria-expanded=\"false\" id=\"base-ui-_R_qf64tb95j5cd356_\" aria-label=\"更多\" type=\"button\" class=\"group x-button transition-colors focus-visible:outline-ring h-8 min-w-8 text-subtext1 [&_svg:not([class*='size-'])]:size-4 text-primary hover:bg-btn-ghost-hover aria-expanded:bg-btn-ghost-hover active:bg-btn-ghost-pressed w-8 px-0 [&_svg]:transition-transform [&_svg]:duration-200 group-hover:[&_svg]:scale-110 -my-2 shrink-0\" style=\"border-radius:9999px\">",
    "<span class=\"x-button-slot\" style=\"opacity:1\">",
    "<svg fill=\"currentColor\" viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<use href=\"#icon-more\" />",
    "</svg>",
    "</span>",
    "</button>",
    "</div>",
    "</div>",
    "</div>",
    "</div>",
    "<div class=\"flex items-center gap-1\">",
    "<span class=\"text-gray-700 [&>svg]:size-4\">",
    "<svg xmlns=\"http://www.w3.org/2000/svg\" fill=\"currentColor\" data-icon=\"icon-grok-logo\" viewBox=\"0 0 33 32\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<path d=\"M12.745 20.54l10.97-8.19c.539-.4 1.307-.244 1.564.38 1.349 3.288.746 7.241-1.938 9.955-2.683 2.714-6.417 3.31-9.83 1.954l-3.728 1.745c5.347 3.697 11.84 2.782 15.898-1.324 3.219-3.255 4.216-7.692 3.284-11.693l.008.009c-1.351-5.878.332-8.227 3.782-13.031L33 0l-4.54 4.59v-.014L12.743 20.544m-2.263 1.987c-3.837-3.707-3.175-9.446.1-12.755 2.42-2.449 6.388-3.448 9.852-1.979l3.72-1.737c-.67-.49-1.53-1.017-2.515-1.387-4.455-1.854-9.789-.931-13.41 2.728-3.483 3.523-4.579 8.94-2.697 13.561 1.405 3.454-.899 5.898-3.22 8.364C1.49 30.2.666 31.074 0 32l10.478-9.466\" />",
    "</svg>",
    "</span>",
    "<button class=\"cursor-pointer bg-transparent hover:underline\" type=\"button\">",
    "<span class=\"max-w-full text-subtext1 font-normal text-brand\">显示翻译</span>",
    "</button>",
    "</div>",
    "<div class=\"max-w-full text-body font-normal text-primary whitespace-pre-wrap wrap-break-word\" dir=\"auto\">",
    "<span class=\"max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]\">Day 3/\n\nThe big one is GPT-6 in Chat, but today is also a little celebration day with a new high of 40M active users across Codex and ChatGPT Work.\n\nLoading a banked reset in everyone's paid accounts. See you again tomorrow!</span>",
    "</div>",
    "<div class=\"flex flex-col gap-1 empty:hidden\">",
    "<div data-href=\"/thsottiaux/status/2107575657014468879\" role=\"link\" tabindex=\"0\" class=\"outline-blue-500 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 rounded-2xl border border-gray-200 overflow-hidden cursor-pointer hover:bg-black-03 dark:hover:bg-white-03\" data-timeline-entry=\"\">",
    "<article>",
    "<div class=\"flex flex-col gap-1 p-3\">",
    "<div class=\"flex min-w-0 flex-1 flex-col gap-1\">",
    "<div class=\"flex min-w-0 items-center gap-1\">",
    "<a class=\"x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 max-w-full rounded-none active\" id=\"base-ui-_r_m_\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<div class=\"x-avatar rounded-full size-6 transition duration-200 hover:brightness-90\">",
    "<img alt=\"@thsottiaux\" class=\"size-full object-cover\" draggable=\"false\" loading=\"lazy\" srcset=\"https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_mini.jpg 1x, https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg 2x, https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_bigger.jpg 3x\" src=\"https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg\">",
    "</div>",
    "</a>",
    "<div class=\"x-middot-group max-w-full text-body font-normal text-secondary min-w-0 overflow-hidden\">",
    "<div class=\"overflow-hidden flex items-center gap-1 min-w-0\" id=\"base-ui-_r_o_\">",
    "<span class=\"flex max-w-full min-w-0 shrink-0 items-center gap-1\">",
    "<a class=\"rounded-xs x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 hover:underline max-w-full min-w-0 active\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<div class=\"max-w-full text-body font-bold text-primary line-clamp-1 break-all min-w-0\">Tibo</div>",
    "</a>",
    "<div class=\"max-w-full text-body font-normal text-primary flex shrink-0 items-center gap-1\">",
    "<span aria-label=\"认证账号\" class=\"flex cursor-pointer items-center\" role=\"button\" tabindex=\"0\" data-base-ui-click-trigger=\"\" id=\"base-ui-_r_q_\" aria-haspopup=\"dialog\" aria-expanded=\"false\">",
    "<svg fill=\"none\" viewBox=\"0 0 24 24\" display=\"flex\" role=\"img\" width=\"1em\" height=\"1em\" aria-hidden=\"true\" aria-label=\"认证账号\" class=\"size-[1em] shrink-0\">",
    "<use href=\"#icon-verified-premium-color\" />",
    "</svg>",
    "</span>",
    "</div>",
    "</span>",
    "<span class=\"flex min-w-0 items-center gap-2\">",
    "<a class=\"rounded-xs x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 max-w-full min-w-0 active\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<span class=\"max-w-full text-body font-normal text-secondary line-clamp-1 [font-feature-settings:'ss01']\">@thsottiaux</span>",
    "</a>",
    "</span>",
    "</div>",
    "<span class=\"inline-flex w-fit shrink-0 whitespace-nowrap\">",
    "<a id=\"_R_5uihll8tb95j5cd356_\" data-base-ui-tooltip-trigger=\"\" class=\"font-chirp max-w-full whitespace-pre-wrap break-words text-gray-700 text-body font-normal hover:underline inline-flex w-fit\" href=\"/thsottiaux/status/2107575657014468879\">10月7日</a>",
    "</span>",
    "</div>",
    "</div>",
    "<div class=\"max-w-full text-body font-normal text-primary line-clamp-5 whitespace-pre-wrap wrap-break-word\" dir=\"auto\">",
    "<span class=\"max-w-full text-[length:inherit] font-[weight:inherit] text-[color:inherit]\">Roundup of Day 2/\n\n2.1/ Approve for me (auto-review) is now included and does not use usage. Can be between 2-10% of plan when used. Also better for you.\n2.2/ Simplified API for builders.\n2.3/ Meeting notes integrated.\n2.4/ Decisions API live for builders. Will use in the app to</span> <button class=\"max-w-full text-[length:inherit] font-normal text-brand hover:underline\" type=\"button\">显示更多</button>",
    "</div>",
    "</div>",
    "</div>",
    "</article>",
    "</div>",
    "</div>",
    "<div class=\"flex shrink items-center text-gray-700\">",
    "<span class=\"inline-flex w-fit\">",
    "<a id=\"_R_5tctb95j5cd356_\" data-base-ui-tooltip-trigger=\"\" class=\"font-chirp max-w-full whitespace-pre-wrap break-words text-gray-700 text-body font-normal hover:underline inline-flex w-fit\" href=\"/thsottiaux/status/2107913674593644711\">3:19 · 2026年10月8日</a>",
    "</span>",
    "<span aria-hidden=\"true\" class=\"shrink-0 px-1 last:hidden\">·</span>",
    "<a class=\"rounded-xs x-link focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70 max-w-full text-subtext1 font-chirp inline-flex items-center gap-1 text-gray-700 active\" id=\"base-ui-_R_1vctb95j5cd356_\" data-base-ui-tooltip-trigger=\"\" href=\"/thsottiaux/status/2107913674593644711\" data-status=\"active\" aria-current=\"page\">",
    "<div class=\"max-w-full text-[length:inherit] font-bold text-primary\">129.4万</div>",
    "<div class=\"max-w-full text-[length:inherit] font-normal text-gray-700\">浏览量</div>",
    "</a>",
    "</div>",
    "</div>",
    "<div class=\"border-border my-2 border-t\">",
    "</div>",
    "<div class=\"-mx-2 flex h-5 min-h-5 w-[calc(100%+16px)] items-center justify-between overflow-visible\">",
    "<div class=\"min-w-0 flex-1\" data-engagement-action=\"reply\">",
    "<a class=\"x-link disabled:cursor-not-allowed disabled:opacity-70 max-w-full group x-engagement-button transition-colors focus-visible:outline-ring hover:text-blue-500 text-secondary\" aria-label=\"回复\" href=\"/compose/post?in_reply_to=2107913674593644711\">",
    "<span class=\"x-engagement-pill before:bg-blue-500/10 h-10 px-3 [&>svg]:size-5\">",
    "<svg fill=\"currentColor\" viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<use href=\"#icon-reply-stroke\" />",
    "</svg>",
    "<span class=\"inline-flex overflow-hidden\" style=\"opacity:1;width:auto;transform:none\">",
    "<span class=\"inline-flex tabular-nums text-subtext2 ps-1\">",
    "<span class=\"x-animated-count-visual\" dir=\"ltr\">1480</span>",
    "</span>",
    "</span>",
    "</span>",
    "</a>",
    "</div>",
    "<div class=\"min-w-0 flex-1\" data-engagement-action=\"retweet\">",
    "<button type=\"button\" tabindex=\"0\" aria-haspopup=\"menu\" aria-expanded=\"false\" id=\"base-ui-_R_fdadb95j5cd356_\" data-slot=\"xds-menu-trigger\" data-base-ui-tooltip-trigger=\"\" aria-label=\"转帖\" aria-pressed=\"false\" class=\"group x-engagement-button transition-colors focus-visible:outline-ring hover:text-green-500 text-secondary\">",
    "<span class=\"x-engagement-pill before:bg-green-500/10 h-10 px-3 [&>svg]:size-5\">",
    "<svg fill=\"currentColor\" viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<use href=\"#icon-retweet-stroke\" />",
    "</svg>",
    "<span class=\"inline-flex overflow-hidden\" style=\"opacity:1;width:auto;transform:none\">",
    "<span class=\"inline-flex tabular-nums text-subtext2 ps-1\">",
    "<span class=\"x-animated-count-visual\" dir=\"ltr\">645</span>",
    "</span>",
    "</span>",
    "</span>",
    "</button>",
    "</div>",
    "<div class=\"min-w-0 flex-1\" data-engagement-action=\"like\">",
    "<button id=\"base-ui-_R_fedb95j5cd356_\" data-base-ui-tooltip-trigger=\"\" aria-label=\"喜欢\" aria-pressed=\"false\" class=\"group x-engagement-button transition-colors focus-visible:outline-ring hover:text-magenta-500 text-secondary\" type=\"button\">",
    "<span class=\"x-engagement-pill before:bg-magenta-500/10 h-10 px-3 [&>svg]:size-5\">",
    "<svg fill=\"currentColor\" viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<use href=\"#icon-heart-stroke\" />",
    "</svg>",
    "<span class=\"inline-flex overflow-hidden\" style=\"opacity:1;width:auto;transform:none\">",
    "<span class=\"inline-flex tabular-nums text-subtext2 ps-1\">",
    "<span class=\"x-animated-count-visual\" dir=\"ltr\">1.8万</span>",
    "</span>",
    "</span>",
    "</span>",
    "</button>",
    "</div>",
    "<div class=\"flex shrink-0 items-center\">",
    "<div>",
    "<div class=\"min-w-0 flex-1\" data-engagement-action=\"bookmark\">",
    "<button id=\"base-ui-_R_1tmdb95j5cd356_\" data-base-ui-tooltip-trigger=\"\" aria-label=\"书签\" aria-pressed=\"false\" class=\"group x-engagement-button transition-colors focus-visible:outline-ring hover:text-blue-500 text-secondary\" type=\"button\">",
    "<span class=\"x-engagement-pill before:bg-blue-500/10 h-10 px-3 [&>svg]:size-5\">",
    "<svg fill=\"currentColor\" viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<use href=\"#icon-bookmark-stroke\" />",
    "</svg>",
    "<span class=\"inline-flex overflow-hidden\" style=\"opacity:1;width:auto;transform:none\">",
    "<span class=\"inline-flex tabular-nums text-subtext2 ps-1\">",
    "<span class=\"x-animated-count-visual\" dir=\"ltr\">751</span>",
    "</span>",
    "</span>",
    "</span>",
    "</button>",
    "</div>",
    "</div>",
    "<button data-engagement-action=\"share\" type=\"button\" tabindex=\"0\" aria-haspopup=\"menu\" aria-expanded=\"false\" id=\"base-ui-_R_1mmdb95j5cd356_\" data-slot=\"xds-menu-trigger\" aria-label=\"分享\" class=\"group x-engagement-button transition-colors focus-visible:outline-ring hover:text-blue-500 text-secondary\">",
    "<span class=\"x-engagement-pill before:bg-blue-500/10 h-10 px-3 [&>svg]:size-5\">",
    "<svg fill=\"currentColor\" viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" display=\"flex\" role=\"img\" aria-hidden=\"true\">",
    "<use href=\"#icon-outgoing\" />",
    "</svg>",
    "</span>",
    "</button>",
    "</div>",
    "</div>",
    "</div>",
    "</article>",
    "<!--/$-->",
    "</div>",
    "</li>",
    "</ul>",
    "</main>",
    "<aside>",
    "<section class=\"overflow-hidden rounded-md border border-border bg-background\">",
    "<div class=\"flex items-center\">",
    "<h2 class=\"text-headline1 text-gray-1100 min-w-0 flex-1 px-4 py-3 font-bold\">相关用户</h2>",
    "</div>",
    "<!--$-->",
    "<div class=\"flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-gray-100\">",
    "<div class=\"flex items-start gap-2\">",
    "<a aria-label=\"Tibo\" class=\"shrink-0 active\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<div class=\"x-avatar rounded-full size-10\">",
    "<img alt=\"Avatar\" class=\"size-full object-cover\" draggable=\"false\" loading=\"lazy\" src=\"https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg\" srcset=\"https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg 1x, https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_x96.jpg 2x, https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_reasonably_small.jpg 3x\">",
    "</div>",
    "</a>",
    "<div class=\"flex min-w-0 flex-1 flex-col gap-1\">",
    "<div class=\"flex items-center justify-between gap-2\">",
    "<a class=\"flex min-w-0 flex-col active\" href=\"/thsottiaux\" data-status=\"active\" aria-current=\"page\">",
    "<span class=\"text-gray-1100 truncate text-[15px] font-bold\">Tibo</span>",
    "<span class=\"truncate text-[15px] text-gray-500\">@<!-- -->thsottiaux</span>",
    "</a>",
    "<a class=\"bg-gray-1100 text-background flex h-8 shrink-0 items-center rounded-full px-4 text-[14px] font-bold transition-colors hover:bg-gray-900\" href=\"/i/jf/onboarding/web?mode=login&redirect_after_login=%2Fthsottiaux\">关注</a>",
    "</div>",
    "<div class=\"text-gray-1100 line-clamp-4 text-[15px]\">Codex &amp; ChatGPT @OpenAI</div>",
    "</div>",
    "</div>",
    "</div>",
    "<!--/$-->",
    "</section>",
    "</aside>",
].join('');

const URL_X = new URL('https://x.com/thsottiaux/status/2107913674593644711');
const xRule = builtinSiteRulePack.rules.find(rule => rule.id === 'x')!;
const xPack: SiteRulePack = {version: 1, rules: [xRule]};
const xAdapters = compileSiteRulePack(xPack);
// The old testid-only rules remain the baseline for comparing the same real DOM.
const legacyAdapters = compileSiteRulePack({version: 1, rules: [{...xRule,
    content: xRule.content!.map(content => ({...content,
        css: content.css.filter(css => css.includes('[data-testid=')),
    })),
}]});

function page(html = PUBLIC_SUBTREES) {
    return parseHTML('<html><body>' + html + '</body></html>').document as unknown as Document;
}
function publicPage() {
    // Optional full original capture; default fixtures remain portable and network-free.
    return process.env.FLUENTREAD_X_DOM_EVIDENCE
        ? parseHTML(readFileSync(process.env.FLUENTREAD_X_DOM_EVIDENCE, 'utf8')).document as unknown as Document
        : page();
}
function targets(document: Document) {
    const main = document.querySelector<HTMLElement>('main div[dir="auto"]')!;
    const bio = Array.from(document.querySelectorAll<HTMLElement>('aside div.line-clamp-4'))
        .find(el => el.textContent === 'Codex & ChatGPT @OpenAI')!;
    expect(main).toBeTruthy(); expect(bio).toBeTruthy();
    return {main, bio};
}
function source(candidate: TranslationCandidate, core: ReturnType<typeof createTranslationCore>) {
    return candidate.nodes ? extractTranslationTextFromNodes(candidate.nodes, core.shouldStayOriginal)
        : extractTranslationText(candidate.element, core.shouldStayOriginal);
}
function adapted(scope: TranslationScope = 'content', url = URL_X) {
    return createTranslationCore({url, adapters: xAdapters, scope});
}
function owner(core: ReturnType<typeof createTranslationCore>, document: Document, element: HTMLElement) {
    const candidates = core.discover(document).filter(candidate => element.contains(candidate.element));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({element});
    expect(candidates[0]!.nodes).toBeUndefined();
    for (const hit of [element, element.firstChild, ...Array.from(element.querySelectorAll('span, a'))]) {
        const hovered = core.resolve(hit);
        expect(hovered?.element).toBe(element);
        expect(hovered?.nodes).toBeUndefined();
        expect(getTranslationCandidateKey(hovered!)).toBe(getTranslationCandidateKey(candidates[0]!));
        expect(source(hovered!, core)).toBe(source(candidates[0]!, core));
    }
    return candidates[0]!;
}

describe('X modern public DOM functional regression', () => {
    it('proves the real main post already has one generic owner without fragmenting or swallowing its quote', () => {
        const document = publicPage();
        const {main, bio} = targets(document);
        expect(document.querySelectorAll('[data-testid]')).toHaveLength(0);
        const original = main.outerHTML;
        for (const [label, adapters] of [['generic', []], ['legacy-x', legacyAdapters], ['current-x', xAdapters]] as const) {
            const core = createTranslationCore({url: URL_X, adapters});
            const candidate = owner(core, document, main);
            expect(candidate.adapterId).toBeUndefined();
            expect(source(candidate, core)).toBe(normalizeTranslationText(main.textContent!));
            expect(source(candidate, core)).toContain('The big one is GPT-6 in Chat');
            expect(source(candidate, core)).not.toMatch(/Roundup|显示翻译|Tibo|@thsottiaux|浏览量/);
            expect(core.discover(document).filter(item => item.element.contains(main))).toEqual([candidate]);
            console.log(JSON.stringify({label, mainOwners: 1, hoverOwnerShared: true,
                bioDiscovered: core.discover(document).some(item => item.element === bio)}));
        }
        expect(main.outerHTML).toBe(original);
    });

    it.each(['content', 'all'] as const)('keeps a shared full-page/hover bio owner and the existing adapter policy in %s scope', scope => {
        const document = publicPage();
        const {bio} = targets(document);
        if (scope === 'content') {
            const legacy = createTranslationCore({url: URL_X, adapters: legacyAdapters, scope});
            expect(legacy.discover(document).some(candidate => candidate.element === bio)).toBe(false);
            expect(legacy.resolve(bio.firstChild)).toBeNull();
        }
        const original = bio.outerHTML;
        const core = adapted(scope);
        const candidate = owner(core, document, bio);
        if (scope === 'content') {
            expect(candidate).toMatchObject({adapterId: 'x', reason: 'x-user-description', kind: 'content'});
        } else {
            // X rules have always applied only to content scope; all scope stays generic.
            expect(candidate.adapterId).toBeUndefined();
            expect(candidate.reason).toBe('generic-readable-block');
        }
        expect(source(candidate, core)).toBe('Codex & ChatGPT @OpenAI');
        expect(core.discover(document).filter(item => item.adapterId === 'x')).toEqual(scope === 'content' ? [candidate] : []);
        expect(bio.outerHTML).toBe(original);
    });

    it('does not force buttons, nickname links, post/quote shells, timestamps or login copy in the real subtree', () => {
        const document = publicPage();
        const {main, bio} = targets(document);
        const adapter = xAdapters[0]!;
        const context = {url: URL_X};
        const quoteShell = document.querySelector('[data-href="/thsottiaux/status/2107575657014468879"]')!;
        const quoteBody = quoteShell.querySelector('div[dir="auto"]')!;
        const negatives = [main, main.closest('article')!, quoteShell, quoteShell.querySelector('article')!, quoteBody,
            ...document.querySelectorAll('button, [role="button"], article a, aside a, aside h2, aside p')];
        const engagementControls = [...document.querySelectorAll('article .x-engagement-button')];
        expect(quoteShell).toBeTruthy();
        expect(engagementControls.length).toBeGreaterThan(0);
        for (const element of negatives) {
            expect(adapter.decide(element, context).kind, element.outerHTML.slice(0,150))
                .toBe(engagementControls.includes(element) ? 'prune-subtree' : 'pass');
            expect(adapted().resolve(element)?.element).not.toBe(bio);
        }
        const before = document.documentElement.outerHTML;
        adapted().discover(document);
        expect(document.documentElement.outerHTML).toBe(before);
    });

    it('ignores lookalike truncation classes outside the exact bio slot, including a quote-shell-shaped div', () => {
        const document = publicPage();
        const {bio} = targets(document);
        const examples = [
            '<main><article><div class="line-clamp-4">A quoted post body.</div></article></main>',
            '<aside><section><div class="line-clamp-4">An unrelated sidebar message.</div></section></aside>',
            '<aside><section><div><div><div><div>Unrelated heading</div><div class="line-clamp-4">A promotional card.</div></div></div></div></section></aside>',
            '<aside><section><div><div><div><div class="items-center justify-between">Profile row</div><div role="link" class="line-clamp-4">A quote-shell link.</div></div></div></div></section></aside>',
        ];
        for (const html of examples) {
            const other = page(html);
            const fake = other.querySelector('.line-clamp-4')!;
            expect(xAdapters[0]!.decide(fake, {url: URL_X}).kind).toBe('pass');
            document.body.appendChild(document.importNode(fake, true));
        }
        expect(adapted().discover(document).filter(candidate => candidate.adapterId === 'x').map(candidate => candidate.element)).toEqual([bio]);
    });

    it('keeps the profile header and follow link outside the bio provider snapshot', () => {
        const document = publicPage();
        const {bio} = targets(document);
        const core = adapted();
        const candidate = owner(core, document, bio);
        const snapshot = createTranslationSourceSnapshot(candidate.element, core.shouldStayOriginal);
        expect(snapshot.slots.map(slot => slot.source).join(' ')).toBe('Codex & ChatGPT @OpenAI');
        expect(snapshot.clone.textContent).not.toMatch(/Tibo|thsottiaux|关注/);
    });

    it('changes the same-page sidebar candidate set by exactly one bio without broadening sidebar ownership', () => {
        const document = publicPage();
        const {main, bio} = targets(document);
        const legacy = createTranslationCore({url: URL_X, adapters: legacyAdapters});
        const before = legacy.discover(document);
        const after = adapted().discover(document);
        const beforeKeys = new Set(before.map(getTranslationCandidateKey));
        const afterKeys = new Set(after.map(getTranslationCandidateKey));
        expect(after.filter(candidate => !beforeKeys.has(getTranslationCandidateKey(candidate))))
            .toEqual([expect.objectContaining({element: bio, adapterId: 'x'})]);
        expect(before.filter(candidate => !afterKeys.has(getTranslationCandidateKey(candidate)))).toEqual([]);
        expect(after.find(candidate => candidate.element === main)?.adapterId).toBeUndefined();
        expect(after.filter(candidate => candidate.adapterId === 'x').map(candidate => candidate.element)).toEqual([bio]);
    });

    it('keeps the same bio owner after source updates, source restoration and repeated discovery', () => {
        const document = publicPage();
        const {bio} = targets(document);
        const core = adapted();
        const original = bio.innerHTML;
        for (const copy of ['Building useful tools for readers.', 'Updated biography with fresh details.']) {
            bio.textContent = copy;
            expect(source(owner(core, document, bio), core)).toBe(copy);
            bio.innerHTML = original;
            expect(source(owner(core, document, bio), core)).toBe('Codex & ChatGPT @OpenAI');
        }
        expect(bio.innerHTML).toBe(original);
    });

    it('preserves emoji, link targets and protected nodes in snapshots without changing host nodes', () => {
        const document = publicPage();
        const {bio} = targets(document);
        // Constructed mutation of the captured bio; this is not a claim about live X markup.
        bio.innerHTML = 'Build useful tools <span>😊</span><img alt="🦫" src="https://example.test/emoji.png">'
            + '<a href="https://example.test/guide"><span>Read the guide</span></a>'
            + '<a href="https://example.test/source" translate="no">Keep this link</a>'
            + '<span translate="no">Local protected phrase</span><code>npm run demo</code>'
            + '<time>2026-10-08</time><span role="progressbar">Loading progress</span>';
        const html = bio.outerHTML;
        const nodes = Array.from(bio.querySelectorAll('*'));
        const core = adapted();
        const candidate = owner(core, document, bio);
        const snapshot = createTranslationSourceSnapshot(candidate.element, core.shouldStayOriginal);
        expect(snapshot.slots.map(slot => slot.source)).toEqual(['Build useful tools', '😊', 'Read the guide']);
        expect(shouldSkipTranslationForTarget('😊', 'zh-Hans')).toBe(true);
        const outputs = new Map([['Build useful tools', '制作实用工具'], ['Read the guide', '阅读指南']]);
        // The existing request precheck keeps a non-letter emoji slot original.
        const rendered = page(applyTranslationsToSnapshot(snapshot, snapshot.slots.map(slot =>
            shouldSkipTranslationForTarget(slot.source, 'zh-Hans') ? slot.source : outputs.get(slot.source)!,
        )));
        expect(rendered.body.textContent).toContain('😊');
        expect(rendered.querySelector('img')?.getAttribute('alt')).toBe('🦫');
        expect(rendered.querySelector('img')?.getAttribute('src')).toBe('https://example.test/emoji.png');
        expect(rendered.querySelector('a')?.getAttribute('href')).toBe('https://example.test/guide');
        expect(rendered.querySelector('a')?.textContent).toBe('阅读指南');
        for (const text of ['Keep this link', 'Local protected phrase', 'npm run demo', '2026-10-08', 'Loading progress']) {
            expect(rendered.body.textContent).toContain(text);
            expect(snapshot.slots.some(slot => slot.source.includes(text))).toBe(false);
        }
        expect(bio.outerHTML).toBe(html);
        expect(Array.from(bio.querySelectorAll('*'))).toEqual(nodes);
    });

    it.each(['translate', 'notranslate', 'editable', 'hidden', 'aria-hidden', 'inert', 'sr-only', 'display-none', 'visibility-hidden'] as const)('does not bypass the %s hard guard around a modern bio', guard => {
        const document = publicPage();
        const {bio} = targets(document);
        if (guard === 'translate') bio.parentElement!.setAttribute('translate', 'no');
        if (guard === 'notranslate') bio.classList.add('notranslate');
        if (guard === 'editable') bio.parentElement!.setAttribute('contenteditable', 'true');
        if (guard === 'hidden') bio.parentElement!.setAttribute('hidden', '');
        if (guard === 'aria-hidden') bio.parentElement!.setAttribute('aria-hidden', 'true');
        if (guard === 'inert') bio.parentElement!.setAttribute('inert', '');
        if (guard === 'sr-only') bio.classList.add('sr-only');
        if (guard === 'display-none' || guard === 'visibility-hidden') {
            const parent = bio.parentElement as HTMLElement;
            parent.style.setProperty(guard === 'display-none' ? 'display' : 'visibility', guard === 'display-none' ? 'none' : 'hidden');
            // Deterministic inline-style fixture; this does not prove X responsive CSS.
            Object.defineProperty(document.defaultView!, 'getComputedStyle', {
                configurable: true,
                value: (element: HTMLElement) => ({display: element.style.display ?? '', visibility: element.style.visibility ?? ''}),
            });
        }
        const core = adapted();
        expect(core.discover(document).some(candidate => candidate.element === bio)).toBe(false);
        expect(core.resolve(bio.firstChild)).toBeNull();
    });

    it.each(['x.com', 'www.x.com', 'twitter.com', 'mobile.twitter.com'])('retains old tweetText/UserDescription owners on %s', hostname => {
        const document = page('<main><article><div data-testid="tweetText">Older post <span>😊</span>'
            + '<a href="https://example.test">linked prose</a></div></article></main>'
            + '<aside><div data-testid="UserDescription">Older biography <span>protected details</span></div></aside>');
        const core = adapted('content', new URL('https://' + hostname + '/person/status/1'));
        for (const [testid, reason] of [['tweetText', 'x-post-text'], ['UserDescription', 'x-user-description']]) {
            const element = document.querySelector<HTMLElement>('[data-testid="' + testid + '"]')!;
            expect(owner(core, document, element)).toMatchObject({adapterId: 'x', reason});
        }
    });

    it.each(['example.test', 'x.com.example.test', 'nottwitter.com'])('does not apply X bio ownership on %s', hostname => {
        const document = publicPage();
        const {bio} = targets(document);
        const url = new URL('https://' + hostname + '/person/status/1');
        const core = adapted('content', url);
        expect(xAdapters[0]!.matches(url)).toBe(false);
        expect(core.discover(document).some(candidate => candidate.element === bio || candidate.adapterId === 'x')).toBe(false);
        expect(core.resolve(bio.firstChild)).toBeNull();
    });

    it('still applies Chinese skip and identical-result suppression to the resolved source', () => {
        const document = publicPage();
        const {main, bio} = targets(document);
        const core = adapted();
        const english = source(owner(core, document, main), core);
        expect(shouldSkipTranslationForTarget(english, 'zh-Hans')).toBe(false);
        bio.textContent = '这是已经写好的中文简介，我们继续保留原来的内容。';
        const chinese = source(owner(core, document, bio), core);
        expect(shouldSkipTranslationForTarget(chinese, 'zh-Hans')).toBe(true);
        expect(shouldSkipTranslationForTarget(chinese, 'en')).toBe(false);
        for (const value of [english, chinese]) {
            expect(hasDistinctTranslation(value, value)).toBe(false);
            expect(hasDistinctTranslation(value, '  ' + value.replace(/ /gu, '\n') + '  ')).toBe(false);
        }
        expect(hasDistinctTranslation(english, '今天发布了新消息。')).toBe(true);
        expect(hasDistinctTranslation(english, undefined)).toBe(false);
    });

    it('keeps valid selectors and the conservative observer fallback for relational author protection', () => {
        const document = publicPage();
        expect(validateSelectors(xPack, document)).toEqual([]);
        expect(getSiteAdapterAttributeFilter(xAdapters)).toEqual(getSiteAdapterAttributeFilter(legacyAdapters));
        // Both content variants retain the current :has() author protection. The
        // compiler conservatively observes all attributes for relational selectors.
        expect(getSiteAdapterAttributeFilter(xAdapters)).toBeNull();
        expect(createTranslationMutationObserverOptions(xAdapters)).toEqual({
            childList: true, subtree: true, characterData: true, characterDataOldValue: true,
            attributes: true, attributeOldValue: true,
        });
    });
});

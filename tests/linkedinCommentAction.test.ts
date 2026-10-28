import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';
import {createTranslationSourceSnapshot} from '@/src/core/translation/serialization';

// The comment action's ancestry and attributes are reduced from a saved public Pulse page;
// nearby prose and lookalikes are negative fixtures, not additional site observations.
const fixture = `<main><article class="article-main"><div class="comments"><section class="comment">
  <a id="author" href="/in/reader">Reader Name</a>
  <p id="comment-body" class="comment__text">A useful comment with <a id="body-link" href="https://example.test/reference">a reading link</a>.</p>
  <div class="comment__text"><div class="comment__actions"><a id="prose-lookalike" href="/pulse/read" class="comment__reply" data-feed-action="replyToComment">A reading link in quoted content</a></div></div>
  <div class="comment__actions"><a id="reply" href="/signup/cold-join" class="comment__action comment__reply" data-feed-action="replyToComment" data-feed-control="reply">
    <div><icon aria-hidden="true"><svg></svg></icon><span id="reply-label" class="action-btn__button-text">回复</span></div>
  </a><a id="other-action" class="comment__action comment__reply" href="/pulse/read" data-feed-action="readArticle">An ordinary reading link</a></div>
</section></div></article>
<div id="outside" class="comment__actions"><a id="outside-link" class="comment__reply" data-feed-action="replyToComment" href="/pulse/read">Outside reading link</a></div></main>`;
const url = new URL('https://www.linkedin.com/pulse/example-article');
const parse = () => parseHTML(`<html><body>${fixture}</body></html>`).document as unknown as Document;
const exactRule = 'main .comments section.comment .comment__actions a.comment__reply[data-feed-action="replyToComment"]:not(.comment__text *)';
const rule = builtinSiteRulePack.rules.find(item => item.id === 'linkedin-articles')!;
const current = compileSiteRulePack(builtinSiteRulePack);
const previousPack = structuredClone(builtinSiteRulePack);
const previousRule = previousPack.rules.find(item => item.id === 'linkedin-articles')!;
previousRule.exclude = previousRule.exclude!.filter(selector => selector !== exactRule);
const previous = compileSiteRulePack(previousPack);
const sources = (core: TranslationCandidateCore, root: Node) => core.discover(root).map(candidate =>
    extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal));

describe('LinkedIn Pulse comment action protection', () => {
    it('protects the observed reply control while preserving comment prose and links', () => {
        const document = parse();
        const reply = document.querySelector('#reply')!;
        const label = document.querySelector('#reply-label')!;
        const body = document.querySelector('#comment-body')!;
        const original = document.body.innerHTML;
        const before = new TranslationCandidateCore({url, adapters: previous});
        const after = new TranslationCandidateCore({url, adapters: current});
        expect(rule.exclude).toContain(exactRule);
        expect(rule.watchIgnore).not.toContain(exactRule);
        expect(sources(before, reply)).toContain('回复');
        expect(before.resolve(label.firstChild)).not.toBeNull();
        expect(after.shouldStayOriginal(reply)).toBe(true);
        expect(after.resolve(label.firstChild)).toBeNull();
        expect(sources(after, reply)).toEqual([]);
        for (const id of ['comment-body', 'body-link', 'author', 'other-action', 'outside-link', 'prose-lookalike']) {
            expect(after.shouldStayOriginal(document.getElementById(id)!), id).toBe(false);
        }
        const bodySnapshot = createTranslationSourceSnapshot(body as HTMLElement, after.shouldStayOriginal);
        expect(bodySnapshot.slots.map(slot => slot.source).join(' ')).toContain('A useful comment');
        expect(bodySnapshot.slots.map(slot => slot.source).join(' ')).toContain('a reading link');
        expect(bodySnapshot.clone.querySelector('#body-link')?.getAttribute('href')).toBe('https://example.test/reference');
        expect(reply.getAttribute('href')).toBe('/signup/cold-join');
        expect(document.body.innerHTML).toBe(original);
    });

    it('does not apply protection to another host or non-Pulse paths', () => {
        const document = parse();
        for (const raw of ['https://example.test/pulse/example-article', 'https://www.linkedin.com/in/reader',
            'https://www.linkedin.com/feed/', 'https://www.linkedin.com/signup/cold-join']) {
            const other = new TranslationCandidateCore({url: new URL(raw), adapters: current});
            expect(other.shouldStayOriginal(document.querySelector('#reply')!), raw).toBe(false);
        }
    });

    it('rechecks dynamically added and changed comment actions without protecting lookalike prose', () => {
        const document = parse();
        const core = new TranslationCandidateCore({url, adapters: current});
        const reply = document.querySelector<HTMLElement>('#reply')!;
        const clone = reply.cloneNode(true) as HTMLElement;
        clone.id = 'dynamic-reply';
        reply.parentElement!.append(clone);
        expect(core.shouldStayOriginal(clone)).toBe(true);
        expect(sources(core, clone)).toEqual([]);
        clone.setAttribute('data-feed-action', 'readArticle');
        expect(core.shouldStayOriginal(clone)).toBe(false);
        expect(sources(core, clone)).toContain('回复');
        clone.setAttribute('data-feed-action', 'replyToComment');
        expect(core.shouldStayOriginal(clone)).toBe(true);
        expect(sources(core, clone)).toEqual([]);
    });
});

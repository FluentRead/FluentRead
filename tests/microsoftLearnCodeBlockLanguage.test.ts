import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';

// Code header structure is reduced from a saved Microsoft Learn Translator reference page.
const fixture = `<main><article>
  <p id="paragraph">Use HTTP and JSON to send a request.</p>
  <div data-code-block-header class="code-block-header">
    <span id="language" class="code-block-header-language">JSON</span>
    <div class="code-block-header-action-bar"><button id="copy">Copy</button></div>
  </div>
  <div data-code-block-header><span id="other-label" class="other-label">An explanation</span></div>
  <div><span id="outside-header" class="code-block-header-language">A readable label</span></div>
</article></main><aside><div data-code-block-header><span id="outside-main" class="code-block-header-language">A sidebar label</span></div></aside>`;
const selector = 'main [data-code-block-header] > span.code-block-header-language';
const rule = builtinSiteRulePack.rules.find(item => item.id === 'microsoft-learn')!;
const previousPack = structuredClone(builtinSiteRulePack);
const previousRule = previousPack.rules.find(item => item.id === 'microsoft-learn')!;
previousRule.exclude = (previousRule.exclude ?? []).filter(item => item !== selector);
const current = compileSiteRulePack(builtinSiteRulePack);
const previous = compileSiteRulePack(previousPack);
const parse = () => parseHTML(`<html><body>${fixture}</body></html>`).document as unknown as Document;
const sources = (core: TranslationCandidateCore, root: Node) => core.discover(root).map(candidate =>
    extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal));
const page = new URL('https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate');

describe('Microsoft Learn code block language labels', () => {
    it('protects code language markers without changing nearby content or controls', () => {
        const document = parse();
        const before = new TranslationCandidateCore({url: page, adapters: previous});
        const after = new TranslationCandidateCore({url: page, adapters: current});
        const language = document.getElementById('language')!;
        const original = document.body.innerHTML;
        expect(rule.exclude).toContain(selector);
        expect(rule.watchIgnore ?? []).not.toContain(selector);
        expect(before.shouldStayOriginal(language)).toBe(false);
        expect(sources(before, document.body)).toContain('JSON');
        expect(after.shouldStayOriginal(language)).toBe(true);
        expect(after.resolve(language.firstChild)).toBeNull();
        expect(sources(after, language.parentElement!).some(source => source.includes('JSON'))).toBe(false);
        for (const id of ['paragraph', 'other-label', 'outside-header', 'outside-main', 'copy']) {
            const element = document.getElementById(id)!;
            expect(after.shouldStayOriginal(element), id).toBe(before.shouldStayOriginal(element));
        }
        expect(sources(after, document.body)).toContain('Use HTTP and JSON to send a request.');
        expect(document.body.innerHTML).toBe(original);
    });

    it('does not alter identical markup on other hosts or excluded routes', () => {
        const document = parse();
        const label = document.getElementById('language')!;
        for (const raw of ['https://example.test/en-us/docs', 'https://learn.microsoft.com/login']) {
            const before = new TranslationCandidateCore({url: new URL(raw), adapters: previous});
            const after = new TranslationCandidateCore({url: new URL(raw), adapters: current});
            expect(after.shouldStayOriginal(label), raw).toBe(before.shouldStayOriginal(label));
        }
    });

    it('protects dynamically inserted code labels without suppressing their surrounding prose', () => {
        const document = parse();
        const core = new TranslationCandidateCore({url: page, adapters: current});
        const article = document.querySelector('article')!;
        const header = document.createElement('div');
        header.setAttribute('data-code-block-header', '');
        header.innerHTML = '<span class="code-block-header-language">curl</span><span>A readable caption.</span>';
        article.append(header);
        const label = header.firstElementChild!;
        expect(core.shouldStayOriginal(label)).toBe(true);
        expect(core.resolve(label.firstChild)).toBeNull();
        expect(sources(core, header)).not.toContain('curl');
        expect(sources(core, header)).toContain('A readable caption.');
    });
});

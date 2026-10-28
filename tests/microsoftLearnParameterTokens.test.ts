import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {TranslationCandidateCore} from '@/src/core/translation/engine';
import {extractTranslationTextFromNodes} from '@/src/core/translation/text';

// Reduced from a saved Translator API reference page; ordinary and outside tables are negative fixtures.
const fixture = `<main><article>
<table aria-label="Required parameters"><thead><tr><th>Query parameter</th><th>Description</th></tr></thead><tbody>
<tr><td id="version">api-version</td><td id="version-description">Required parameter for the selected version.</td></tr>
<tr><td id="to">to</td><td>Specifies the language of the output text.</td></tr></tbody></table>
<table aria-label="Optional parameters"><thead><tr><th>Query parameter</th><th>Description</th></tr></thead><tbody>
<tr><td id="from">from</td><td>Specifies the language of the input text.</td></tr>
<tr><td id="category">category</td><td>Specifies the translation category.</td></tr></tbody></table>
<table aria-label="Optional parameters"><thead><tr><th>Headers</th><th>Description</th></tr></thead><tbody>
<tr><td id="content-type">Content-Type</td><td>Specifies the content type of the payload.</td></tr>
<tr><td id="authentication">Authentication headers</td><td>See available authentication options.</td></tr></tbody></table>
<table aria-label="Response headers"><thead><tr><th>Headers</th><th>Description</th></tr></thead><tbody>
<tr><td id="request-id">X-requestid</td><td>Identifies the request.</td></tr></tbody></table>
<table aria-label="Handle profanity"><thead><tr><th id="enum-header">Accepted ProfanityAction value</th><th>ProfanityMarker value</th><th>Action</th><th>Example: Source - Spanish</th><th>Example: Target - English</th></tr></thead><tbody>
<tr><td id="no-action">NoAction</td><td></td><td id="action-description">Default. Same as not setting the option.</td><td id="source-example">Que coche de example</td><td id="target-example">What a car</td></tr>
<tr><td id="marked">Marked</td><td id="asterisk">Asterisk</td><td>Asterisks replace profane words.</td><td>Source example.</td><td>Target example.</td></tr>
<tr><td>Marked</td><td id="tag">Tag</td><td>Profane words are surrounded by XML tags.</td><td>Source example.</td><td>Target example.</td></tr>
<tr><td id="deleted">Deleted</td><td></td><td>Profane words are removed.</td><td>Source example.</td><td>Target example.</td></tr>
<tr><td id="enum-prose">A readable explanation</td><td id="enum-prose-two">An ordinary label</td><td>Description stays readable.</td><td>Source example.</td><td>Target example.</td></tr></tbody></table>
<table aria-label="Response status codes"><thead><tr><th>Status</th><th>Meaning</th></tr></thead><tbody>
<tr><td id="ordinary">Success</td><td>Request succeeded.</td></tr></tbody></table>
<p id="paragraph">This paragraph describes the required parameters.</p>
</article></main><aside><table aria-label="Required parameters"><tbody><tr><td id="outside">History</td></tr></tbody></table></aside>`;
const url = new URL('https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate');
const selectors = [
    'main table[aria-label="Required parameters"] tbody tr > td:first-child',
    'main table[aria-label="Optional parameters"] tbody tr > td:first-child',
    'main table[aria-label="Response headers"] tbody tr > td:first-child',
    'main table[aria-label="Handle profanity"] tbody tr > td:nth-child(-n+2)',
];
const rule = builtinSiteRulePack.rules.find(item => item.id === 'microsoft-learn-translator-v3-parameters')!;
const current = compileSiteRulePack(builtinSiteRulePack);
const previousPack = structuredClone(builtinSiteRulePack);
const previousRule = previousPack.rules.find(item => item.id === 'microsoft-learn-translator-v3-parameters')!;
previousRule.literalTokens = (previousRule.literalTokens ?? []).filter(selector => !selectors.includes(selector));
const previous = compileSiteRulePack(previousPack);
const parse = () => parseHTML(`<html><body>${fixture}</body></html>`).document as unknown as Document;
const sources = (core: TranslationCandidateCore, root: Node) => core.discover(root).map(candidate =>
    extractTranslationTextFromNodes(candidate.nodes ?? [candidate.element], core.shouldStayOriginal));

describe('Microsoft Learn parameter table literal tokens', () => {
    it('protects observed first-column identifiers without suppressing prose', () => {
        const document = parse();
        const before = new TranslationCandidateCore({url, adapters: previous});
        const after = new TranslationCandidateCore({url, adapters: current});
        const original = document.body.innerHTML;
        for (const selector of selectors) expect(rule.literalTokens).toContain(selector);
        for (const id of ['version', 'to', 'from', 'category', 'content-type', 'request-id', 'no-action', 'marked', 'asterisk', 'deleted', 'tag']) {
            const cell = document.getElementById(id)!;
            expect(before.shouldStayOriginal(cell), id).toBe(false);
            expect(before.resolve(cell.firstChild), id).not.toBeNull();
            expect(after.shouldStayOriginal(cell), id).toBe(true);
            expect(after.resolve(cell.firstChild), id).toBeNull();
            expect(sources(after, cell), id).toEqual([]);
        }
        for (const id of ['version-description', 'authentication', 'ordinary', 'paragraph', 'enum-header',
            'action-description', 'source-example', 'target-example', 'enum-prose', 'enum-prose-two']) {
            const element = document.getElementById(id)!;
            expect(after.shouldStayOriginal(element), id).toBe(false);
            expect(after.resolve(element.firstChild), id).not.toBeNull();
        }
        expect(after.shouldStayOriginal(document.getElementById('outside')!)).toBe(before.shouldStayOriginal(document.getElementById('outside')!));
        expect(sources(after, document.getElementById('version-description')!)).toContain('Required parameter for the selected version.');
        expect(document.body.innerHTML).toBe(original);
    });

    it('does not apply the rule to another host or excluded paths', () => {
        const document = parse();
        for (const raw of ['https://example.test/en-us/docs', 'https://learn.microsoft.com/login',
            'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/languages',
            'https://learn.microsoft.com/zh-cn/azure/ai-services/translator/text-translation/reference/v3/translate']) {
            const other = new TranslationCandidateCore({url: new URL(raw), adapters: current});
            expect(other.shouldStayOriginal(document.getElementById('version')!), raw).toBe(false);
            expect(other.shouldStayOriginal(document.getElementById('no-action')!), raw).toBe(false);
        }
    });

    it('rechecks dynamically added cells, changed text and changed table semantics', () => {
        const document = parse();
        const core = new TranslationCandidateCore({url, adapters: current});
        const table = document.querySelector('table[aria-label="Optional parameters"]')!;
        const row = document.createElement('tr');
        row.innerHTML = '<td>Natural language description</td><td>A readable explanation.</td>';
        table.querySelector('tbody')!.append(row);
        const first = row.firstElementChild!;
        expect(core.shouldStayOriginal(first)).toBe(false);
        expect(core.shouldStayOriginal(first.nextElementSibling!)).toBe(false);
        first.textContent = 'textType';
        expect(core.shouldStayOriginal(first)).toBe(true);
        expect(sources(core, first)).toEqual([]);
        table.setAttribute('aria-label', 'Response status codes');
        expect(core.shouldStayOriginal(first)).toBe(false);
        expect(sources(core, first)).toContain('textType');
        table.setAttribute('aria-label', 'Optional parameters');
        expect(core.shouldStayOriginal(first)).toBe(true);
    });

    it('rechecks a cell with an existing bilingual translation while preserving single-slot source text', () => {
        const document = parse();
        const core = new TranslationCandidateCore({url, adapters: current});
        const cell = document.getElementById('from')!;
        cell.innerHTML = 'from<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">现有译文</span>';
        const original = cell.innerHTML;
        expect(core.shouldStayOriginal(cell)).toBe(true);
        expect(core.resolve(cell.firstChild)).toBeNull();
        expect(cell.innerHTML).toBe(original);
        cell.firstChild!.textContent = 'A readable description';
        expect(core.shouldStayOriginal(cell)).toBe(false);
        cell.innerHTML = '<span class="fluent-read-single-slot" data-fr-translation-owned="true" translate="no">from</span>';
        expect(core.shouldStayOriginal(cell)).toBe(true);
        cell.innerHTML = 'from<span class="fluent-read-bilingual-content"> native text</span>';
        expect(core.shouldStayOriginal(cell)).toBe(false);
    });

    it('reads custom elements without cloning or dropping source text in single-slot and lookalike nodes', () => {
        const document = parse();
        const core = new TranslationCandidateCore({url, adapters: current});
        const cell = document.getElementById('from')!;
        cell.innerHTML = '<site-param>fr<span class="fluent-read-single-slot" data-fr-translation-owned="true">om</span></site-param>' +
            '<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">现有译文</span>';
        const custom = cell.querySelector('site-param')!;
        const cloneCell = vi.spyOn(cell, 'cloneNode').mockImplementation(() => {throw new Error('must not clone');});
        const cloneCustom = vi.spyOn(custom, 'cloneNode').mockImplementation(() => {throw new Error('must not clone custom elements');});
        const original = cell.innerHTML;
        expect(core.shouldStayOriginal(cell)).toBe(true);
        expect(cloneCell).not.toHaveBeenCalled();
        expect(cloneCustom).not.toHaveBeenCalled();
        expect(cell.innerHTML).toBe(original);
        cell.querySelector('.fluent-read-bilingual-content')!.setAttribute('data-fr-translation-owned', 'false');
        expect(core.shouldStayOriginal(cell)).toBe(false);
        cell.innerHTML = 'from<span data-fr-translation-owned="true"> native text</span>';
        expect(core.shouldStayOriginal(cell)).toBe(false);
    });

    it('reads ordered Text and CDATA source nodes while ignoring comments and bilingual copies', () => {
        const document = parse();
        const core = new TranslationCandidateCore({url, adapters: current});
        const cell = document.getElementById('from')!;
        const owned = document.createElement('span');
        owned.className = 'fluent-read-bilingual-content';
        owned.setAttribute('data-fr-translation-owned', 'true');
        owned.textContent = '现有译文';
        cell.replaceChildren(document.createTextNode('fr'), document.createCDATASection('om'),
            document.createComment('site comment should not contribute text'), owned);
        expect(core.shouldStayOriginal(cell)).toBe(true);
        expect(cell.childNodes[0]!.textContent).toBe('fr');
        expect(cell.childNodes[1]!.textContent).toBe('om');
        expect(owned.textContent).toBe('现有译文');
    });
});

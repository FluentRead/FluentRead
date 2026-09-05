import {readFileSync} from 'node:fs';

import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';

import {
    createTranslationCore,
    extractTranslationText,
    extractTranslationTextFromNodes,
    isClearlyTargetLanguage,
} from '@/src/core/translation/public';
import type {TranslationCandidate, TranslationCandidateCore} from '@/src/core/translation/public';

const fixtureRoot = new URL('./fixtures/translation-pages/', import.meta.url);

function loadFixture(name: string, url: string) {
    const html = readFileSync(new URL(name, fixtureRoot), 'utf8');
    const {document} = parseHTML(html);
    return {
        document,
        core: createTranslationCore({url: new URL(url)}),
    };
}

function installInlineDisplayStyles(document: Document): void {
    const view = document.defaultView!;
    Object.defineProperty(view, 'getComputedStyle', {
        configurable: true,
        value: (element: Element) => {
            const display = element.getAttribute('style')
                ?.match(/(?:^|;)\s*display\s*:\s*([^;]+)/iu)?.[1]
                ?.trim()
                .toLowerCase() ?? '';
            return {display, visibility: 'visible'};
        },
    });
}

function fixtureId(element: Element): string | null {
    return element.getAttribute('data-testid');
}

function expectExactCandidateOwners(
    candidates: readonly TranslationCandidate[],
    expected: readonly string[],
    region: string,
): void {
    const anonymous = candidates
        .filter((candidate) => !fixtureId(candidate.element))
        .map((candidate) => `${candidate.element.tagName.toLowerCase()}:${candidate.reason}`);
    expect(anonymous, `${region}: every candidate must identify its page region`).toEqual([]);

    const actual = candidates.map((candidate) => fixtureId(candidate.element)!);
    expect(
        [...actual].sort(),
        `${region}: whole-document discovery lost or added a translation owner`,
    ).toEqual([...expected].sort());
}

function candidateSource(candidate: TranslationCandidate, core: TranslationCandidateCore): string {
    return candidate.nodes
        ? extractTranslationTextFromNodes(candidate.nodes, core.shouldStayOriginal)
        : extractTranslationText(candidate.element, core.shouldStayOriginal);
}

function providerReadyIds(
    candidates: readonly TranslationCandidate[],
    core: TranslationCandidateCore,
    targetLanguage: string,
): string[] {
    return candidates
        .filter((candidate) => !isClearlyTargetLanguage(candidateSource(candidate, core), targetLanguage))
        .map((candidate) => fixtureId(candidate.element))
        .filter((value): value is string => Boolean(value));
}

describe('offline whole-document translation corpus', () => {
    it('covers the GitHub PR 4038 title and every markdown H2/P/LI while pruning Quick Search', () => {
        const {document, core} = loadFixture(
            'github-pr-4038.html',
            'https://github.com/FluentRead/FluentRead/pull/428',
        );
        const candidates = core.discover(document);
        const expected = [
            'pr-title',
            'change-heading',
            'change-list-one',
            'change-list-two',
            'change-summary',
            'why-heading',
            'why-copy',
            'validation-heading',
            'validation-list',
        ];

        expectExactCandidateOwners(
            candidates,
            expected,
            'GitHub PR 4038 title and conversation body',
        );

        const counts = candidates.reduce<Record<string, number>>((result, candidate) => {
            result[candidate.element.tagName] = (result[candidate.element.tagName] ?? 0) + 1;
            return result;
        }, {});
        expect(
            counts,
            'GitHub PR 4038 coverage must include its H1 plus every H2, paragraph, and list leaf',
        ).toMatchObject({H1: 1, H2: 3, P: 2, LI: 3});

        for (const id of expected.filter((value) => value !== 'pr-title')) {
            expect(
                candidates.find((candidate) => fixtureId(candidate.element) === id),
                `GitHub PR body region ${id} must be owned by the GitHub markdown adapter`,
            ).toMatchObject({adapterId: 'github', reason: 'github-markdown-prose'});
        }

        const summary = document.querySelector('[data-testid="change-summary"]')!;
        const linkText = document.querySelector('[data-testid="change-link"]')?.firstChild;
        expect(
            core.resolve(linkText)?.element,
            'GitHub inline links must resolve to their complete paragraph, not a partial child',
        ).toBe(summary);
        expect(
            candidates.some((candidate) => fixtureId(candidate.element) === 'change-link'),
            'GitHub inline links must not become duplicate translation requests',
        ).toBe(false);

        const searchInput = document.querySelector('[data-testid="quick-search-input"]')!;
        const searchSuggestion = document.querySelector('[data-testid="quick-search-suggestion"]')!;
        expect(core.resolve(searchInput), 'Quick Search input must remain page-controlled').toBeNull();
        expect(core.resolve(searchSuggestion), 'Quick Search suggestions must remain page-controlled').toBeNull();
        expect(
            candidates.some((candidate) => fixtureId(candidate.element)?.startsWith('quick-search')),
            'Quick Search must not leak into full-page translation candidates',
        ).toBe(false);
        expect(
            core.shouldIgnoreMutation(document.querySelector('[data-testid="change-heading"]')!),
            'GitHub live conversation content must remain eligible for later dirty-subtree discovery',
        ).toBe(false);
    });

    it('walks an MDN-like display:contents document incrementally without swallowing semantic regions', () => {
        const {document, core} = loadFixture(
            'mdn-display-contents.html',
            'https://developer.mozilla.org/en-US/docs/Web/API/Example',
        );
        installInlineDisplayStyles(document);

        const steps = [...core.discoverSteps(document)];
        const candidates = steps.flatMap((step) => step.candidate ? [step.candidate] : []);
        expectExactCandidateOwners(candidates, [
            'mdn-title',
            'syntax-heading',
            'syntax-copy',
            'protected-inline-copy',
            'notes-heading',
            'notes-copy',
        ], 'MDN display:contents main and article');

        const main = document.querySelector('[data-testid="mdn-main"]')!;
        const semanticSection = document.querySelector('[data-testid="mdn-semantic-section"]')!;
        expect(
            steps.filter((step) => step.element === main).map((step) => step.phase),
            'The transparent MDN main must still be entered and exited during full Document discovery',
        ).toEqual(['enter', 'exit']);
        expect(
            candidates.some((candidate) => candidate.element === main || candidate.element === semanticSection),
            'Transparent semantic containers must remain ownership boundaries rather than one giant request',
        ).toBe(false);

        const syntax = document.querySelector('[data-testid="syntax-copy"]')!;
        const syntaxLinkText = document.querySelector('[data-testid="syntax-link"]')?.firstChild;
        expect(
            core.resolve(syntaxLinkText)?.element,
            'MDN inline links must resolve to the surrounding prose leaf',
        ).toBe(syntax);

        const protectedParagraph = document.querySelector('[data-testid="protected-inline-copy"]')!;
        const providerText = extractTranslationText(protectedParagraph, core.shouldStayOriginal);
        expect(providerText, 'Readable prose around MDN inline code must still be translated').toContain('Call');
        expect(providerText, 'Inline code must never enter the provider request').not.toContain('example.connect');
        expect(providerText, 'translate=no tokens must never enter the provider request').not.toContain('API_TOKEN');
        expect(
            core.resolve(document.querySelector('[data-testid="standalone-code"]')),
            'Standalone pre/code examples must not resolve to a translation candidate',
        ).toBeNull();
        expect(
            candidates.some((candidate) => fixtureId(candidate.element) === 'mdn-aside-copy'),
            'MDN related-tools chrome must remain outside the content corpus',
        ).toBe(false);
    });

    it('recognizes Bambu-like prose, lists, and table cells and applies the target-language request gate', () => {
        const {document, core} = loadFixture(
            'bambu-wiki-prose-table.html',
            'https://wiki.bambulab.com/en/software/bambu-studio/manual/dual-nozzles-slicing-filament-grouping',
        );
        const candidates = core.discover(document);
        expectExactCandidateOwners(candidates, [
            'bambu-title',
            'bambu-intro',
            'grouping-heading',
            'grouping-instructions',
            'rule-one',
            'rule-two',
            'nozzle-column',
            'filament-column',
            'left-nozzle',
            'pla-filament',
            'target-language-copy',
        ], 'Bambu wiki prose and table');

        const intro = document.querySelector('[data-testid="bambu-intro"]')!;
        const linkText = document.querySelector('[data-testid="bambu-inline-link"]')?.firstChild;
        expect(
            core.resolve(linkText)?.element,
            'Bambu article links must stay continuous with the surrounding paragraph',
        ).toBe(intro);

        const ready = providerReadyIds(candidates, core, 'zh-CN');
        expect(
            ready,
            'Already-Chinese leaves may be structural candidates but must not reach the translation provider',
        ).not.toContain('target-language-copy');
        expect(ready, 'English Bambu table cells must remain provider-ready').toEqual(expect.arrayContaining([
            'nozzle-column',
            'filament-column',
            'left-nozzle',
            'pla-filament',
        ]));
        expect(
            candidates.some((candidate) => fixtureId(candidate.element) === 'protected-wiki-copy'),
            'Bambu notranslate content must be excluded during Document discovery',
        ).toBe(false);
        expect(
            candidates.some((candidate) => ['wiki-navigation-copy', 'wiki-aside-copy', 'bambu-header-subtitle']
                .includes(fixtureId(candidate.element) ?? '')),
            'Bambu navigation, tools, and article metadata must remain structural chrome',
        ).toBe(false);
    });

    it('rediscovers dynamic leaves and open Shadow DOM after an entire body replacement', () => {
        const {document, core} = loadFixture(
            'dynamic-shadow-replacement.html',
            'https://example.test/live-document',
        );
        const initialHost = document.querySelector('[data-testid="initial-shadow-host"]')!;
        const initialShadow = initialHost.attachShadow({mode: 'open'});
        initialShadow.innerHTML = `
            <section>
                <h2 data-testid="initial-shadow-heading">Component details</h2>
                <p data-testid="initial-shadow-copy">An open component root exposes readable guidance.</p>
            </section>
        `;

        expectExactCandidateOwners(core.discover(document), [
            'live-page-title',
            'initial-copy',
            'dynamic-copy',
            'initial-shadow-heading',
            'initial-shadow-copy',
        ], 'Initial dynamic document and open Shadow DOM');

        const panel = document.querySelector('[data-testid="dynamic-panel"]')!;
        const added = document.createElement('p');
        added.setAttribute('data-testid', 'dynamic-added-copy');
        added.textContent = 'A mutation adds another readable paragraph to this panel.';
        panel.appendChild(added);
        expectExactCandidateOwners(
            core.discover(panel),
            ['dynamic-copy', 'dynamic-added-copy'],
            'Dirty dynamic panel rediscovery',
        );

        const template = document.querySelector('[data-testid="replacement-body-template"]') as HTMLTemplateElement;
        const replacementBody = document.createElement('body');
        replacementBody.setAttribute('data-testid', 'replacement-body');
        replacementBody.appendChild(template.content.cloneNode(true));
        document.body.replaceWith(replacementBody);

        const replacementHost = document.querySelector('[data-testid="replacement-shadow-host"]')!;
        const replacementShadow = replacementHost.attachShadow({mode: 'open'});
        replacementShadow.innerHTML = `
            <article>
                <h2 data-testid="replacement-shadow-heading">Current component details</h2>
                <p data-testid="replacement-shadow-copy">The replacement component exposes fresh readable guidance.</p>
            </article>
        `;
        const replacementCandidates = core.discover(document);
        expectExactCandidateOwners(replacementCandidates, [
            'replacement-nav-title',
            'replacement-copy',
            'replacement-shadow-heading',
            'replacement-shadow-copy',
        ], 'Replacement body and replacement open Shadow DOM');
        expect(
            replacementCandidates.some((candidate) => fixtureId(candidate.element)?.startsWith('initial-') ||
                fixtureId(candidate.element)?.startsWith('dynamic-')),
            'Detached body candidates must not survive a fresh whole-Document scan',
        ).toBe(false);
        expect(
            core.resolve(document.querySelector('[data-testid="replacement-protected-copy"]')),
            'translate=no descendants in a replacement body must remain excluded',
        ).toBeNull();
    });

    it('keeps LearnOpenGL fixed-height navigation intact while covering the complete reading surface', () => {
        const {document, core} = loadFixture(
            'learnopengl-fixed-navigation.html',
            'https://learnopengl.com/Getting-started/Coordinate-Systems',
        );
        const candidates = core.discover(document);

        expectExactCandidateOwners(candidates, [
            'coordinate-title',
            'coordinate-intro',
            'projection-heading',
            'projection-copy',
        ], 'LearnOpenGL reading surface and fixed-height navigation');
        expect(
            core.resolve(document.querySelector('[data-testid="navigation-link"]')?.firstChild),
            'The image-backed navigation must never receive a bilingual wrapper from hover',
        ).toBeNull();
        expect(
            core.resolve(document.querySelector('[data-testid="navigation-toggle"]')?.firstChild),
            'The image-backed navigation toggle must remain page-owned',
        ).toBeNull();

        const projection = document.querySelector('[data-testid="projection-copy"]')!;
        const providerText = extractTranslationText(projection, core.shouldStayOriginal);
        expect(providerText).toContain('Perspective projection');
        expect(providerText).toContain('The prose remains one readable paragraph.');
        expect(providerText).not.toMatch(/FORMULA_(?:PREVIEW|RENDERER|SOURCE)_SECRET/u);
        expect(
            core.resolve(document.querySelector('[data-testid="code-sample"]')),
            'Standalone OpenGL code remains a hard translation boundary',
        ).toBeNull();
    });

    it('covers the QQ Mail reading surface across presentation tables and dynamic mail replacement', () => {
        const {document, core} = loadFixture(
            'qqmail-reading.html',
            'https://wx.mail.qq.com/home/index#/list/6',
        );
        installInlineDisplayStyles(document);
        const expected = [
            'mail-greeting',
            'mail-body',
            'mail-table-cell',
            'mail-nested-cell',
            'mail-protected-around',
        ];
        const candidates = [...core.discoverSteps(document)]
            .flatMap((step) => step.candidate ? [step.candidate] : []);
        expectExactCandidateOwners(candidates, expected, 'QQ Mail presentation-table reading surface');
        expect(
            candidates.some((candidate) => fixtureId(candidate.element) === 'mail-table-cell-two'),
            'A presentation cell containing a paragraph must defer ownership to its readable paragraph leaf',
        ).toBe(false);

        for (const id of expected) {
            const element = document.querySelector(`[data-testid="${id}"]`)!;
            const discovered = candidates.find((candidate) => candidate.element === element);
            expect(discovered, `${id}: full discovery must produce a candidate`).toBeDefined();
            expect(
                core.resolve(element.firstChild)?.element,
                `${id}: hover resolution must select the same readable leaf`,
            ).toBe(element);
        }

        const protectedAround = document.querySelector('[data-testid="mail-protected-around"]')!;
        const providerText = extractTranslationText(protectedAround, core.shouldStayOriginal);
        expect(providerText).toContain('Readable text around');
        expect(providerText).toContain('and');
        expect(providerText).not.toContain('SECRET_CODE_DO_NOT_TRANSLATE');
        expect(providerText).not.toContain('PROTECTED_TOKEN');
        for (const id of ['mail-editable', 'mail-hidden']) {
            expect(
                candidates.some((candidate) => fixtureId(candidate.element) === id),
                `${id}: page-controlled or hidden content must not become a full-page candidate`,
            ).toBe(false);
            expect(core.resolve(document.querySelector(`[data-testid="${id}"]`)!)).toBeNull();
        }

        const replacement = document.createElement('div');
        replacement.className = 'mail-detail-content';
        replacement.innerHTML = '<div class="qmbox"><table role="presentation"><tbody><tr><td><p data-testid="replacement-mail-body">The newly opened message has fresh readable content.</p></td></tr></tbody></table></div>';
        document.querySelector('[data-testid="mail-detail-content"]')!.replaceWith(replacement);
        const replacementCandidates = core.discover(replacement);
        expectExactCandidateOwners(
            replacementCandidates,
            ['replacement-mail-body'],
            'QQ Mail dynamic message replacement',
        );
        expect(
            replacementCandidates.some((candidate) => fixtureId(candidate.element)?.startsWith('mail-')),
            'A replaced message must not retain candidates from the previous message',
        ).toBe(false);
    });
});

describe('minimal candidate-boundary constructions', () => {
    it('keeps structural headings, controls, transparent semantics, and language gates distinct', () => {
        const {document} = parseHTML(`
            <html><body>
                <header>
                    <h1 data-testid="header-heading">Header-owned page title</h1>
                    <p data-testid="header-copy">Ordinary header navigation prose</p>
                </header>
                <nav>
                    <h1 data-testid="nav-heading">Navigation-owned document title</h1>
                    <p data-testid="nav-copy">Ordinary navigation description</p>
                </nav>
                <main>
                    <h1 data-testid="control-heading">
                        Install FluentRead <button data-testid="copy-control">Copy command</button> after verifying settings.
                    </h1>
                    <section data-testid="semantic-boundary" style="display: contents">
                        Leading semantic overview.
                        <p data-testid="semantic-child">A nested semantic paragraph remains its own leaf.</p>
                        Trailing semantic summary.
                    </section>
                    <p data-testid="already-chinese">这段中文不需要再次翻译。</p>
                    <section translate="no"><p data-testid="no-translate-child">Never translate this protected subtree.</p></section>
                </main>
            </body></html>
        `);
        installInlineDisplayStyles(document);
        const core = createTranslationCore({url: new URL('https://example.test/boundaries')});
        const candidates = core.discover(document);

        for (const id of ['header-heading', 'nav-heading']) {
            const heading = document.querySelector(`[data-testid="${id}"]`)!;
            expect(
                candidates.find((candidate) => candidate.element === heading),
                `${id}: semantic H1 must override structural header/nav ancestry`,
            ).toMatchObject({kind: 'content', reason: 'generic-readable-block'});
        }
        expect(
            candidates.some((candidate) => ['header-copy', 'nav-copy'].includes(fixtureId(candidate.element) ?? '')),
            'Ordinary structural chrome must remain excluded even when structural H1 is included',
        ).toBe(false);

        const controlHeading = document.querySelector('[data-testid="control-heading"]')!;
        const copyControl = document.querySelector('[data-testid="copy-control"]')!;
        const headingRuns = candidates.filter((candidate) => candidate.element === controlHeading);
        expect(
            headingRuns.map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim()),
            'A direct button must split, not consume, the readable H1 text on both sides',
        ).toEqual(['Install FluentRead', 'after verifying settings.']);
        expect(
            candidates.find((candidate) => candidate.element === copyControl),
            'The direct button must remain a separate control candidate',
        ).toMatchObject({kind: 'control', reason: 'generic-control'});

        const semanticBoundary = document.querySelector('[data-testid="semantic-boundary"]')!;
        const semanticRuns = candidates.filter((candidate) => candidate.element === semanticBoundary);
        expect(
            semanticRuns.map((candidate) => candidate.nodes?.map((node) => node.textContent).join('').trim()),
            'A display:contents semantic section must preserve direct text around its block child',
        ).toEqual(['Leading semantic overview.', 'Trailing semantic summary.']);
        expect(
            semanticRuns.some((candidate) => candidate.nodes?.includes(semanticBoundary as ChildNode)),
            'A transparent semantic region must never be reparented into its own inline run',
        ).toBe(false);

        expect(
            providerReadyIds(candidates, core, 'zh-CN'),
            'The target-language gate must remove already-Chinese leaves before provider scheduling',
        ).not.toContain('already-chinese');
        expect(
            candidates.some((candidate) => fixtureId(candidate.element) === 'no-translate-child'),
            'translate=no must be a hard discovery boundary',
        ).toBe(false);
    });
});

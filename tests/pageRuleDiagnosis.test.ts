import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {setCurrentTranslationAdapters} from '@/src/core/translation/current';
import type {TranslationCandidate, TranslationScope} from '@/src/core/translation/types';
import {createDeclarativeAdapter} from '@/src/core/translation/adapters/declarative';
import {diagnosePageRuleSelection, readPageRuleSelection} from '@/src/features/full-page-translation/content/pageRuleDiagnosis';
import {createLifecycleRetry} from '@/src/features/full-page-translation/content/translationStability';

const state = vi.hoisted(() => ({
    read: vi.fn(),
    owner: vi.fn((candidate: TranslationCandidate): HTMLElement | null => candidate.element),
}));
vi.mock('@/src/features/full-page-translation/content/state', () => ({
    getTranslationState: state.read,
    resolveTranslationStateNode: state.owner,
}));

const baseUrl = new URL('https://example.test/article');
const rule = createDeclarativeAdapter({
    id: 'fixture', hosts: ['example.test'], genericCandidatePolicy: 'targets-only',
    targets: [{selector: 'article p', match: 'closest', reason: 'article'}],
    prune: [{selector: '.omit', reason: 'fixture:exclude'}],
    keepOriginal: [{selector: '.label', reason: 'fixture:protect'}],
});
const site = '<article><p id="target">A readable paragraph with several words. <em class="label">Editorial credit</em></p>' +
    '<div class="omit"><p id="exclude">Another complete sentence.</p></div>' +
    '<p id="hard" translate="no">Do not translate this content.</p>' +
    '<p id="protected"><code>This inline code remains protected.</code></p></article>' +
    '<p id="outside">Further text lives outside the article.</p>' +
    '<p id="owner"><span class="fluent-read-bilingual-content">An owned artifact.</span></p>';
const source = 'A readable paragraph with several words.';

function fixture() {
    vi.stubGlobal('location', baseUrl);
    setCurrentTranslationAdapters([rule]);
    const {document} = parseHTML('<html><body>' + site + '</body></html>');
    const target = document.querySelector<HTMLElement>('#target')!;
    const start = target.firstChild!;
    const candidate: TranslationCandidate = {element: target, adapterId: 'fixture', reason: 'article', kind: 'content'};
    type Session = NonNullable<Parameters<typeof diagnosePageRuleSelection>[2]>;
    const session: Session = {
        scope: 'content', translationConfig: {} as Session['translationConfig'],
        scheduled: new Map(), inFlightCandidates: new Map(), unchangedCandidates: new WeakMap(),
        userCancelledCandidates: new WeakMap(),
    };
    const readSource = vi.fn(() => source);
    const checkLanguage = vi.fn(() => false);
    const diagnose = (start: Node | undefined, scope: TranslationScope = 'content', session?: Session) =>
        diagnosePageRuleSelection(start, scope, session, readSource, checkLanguage);
    return {document, target, start, candidate, session, readSource, checkLanguage, diagnose};
}

afterEach(() => {
    setCurrentTranslationAdapters([]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    state.read.mockReset();
    state.owner.mockReset();
});

describe('current page rule diagnosis', () => {
    it('keeps the extension-only selection query out of the userscript', () => {
        vi.stubEnv('BROWSER', 'userscript');
        const {document} = fixture();
        expect(readPageRuleSelection(document)).toBeUndefined();
    });

    it('reads the start of the first selected range and accepts selection from an element offset', () => {
        const {document, target, start} = fixture();
        const anchor = vi.fn();
        Object.defineProperty(document, 'getSelection', {value: anchor});
        anchor.mockReturnValue(null);
        expect(readPageRuleSelection(document)).toBeUndefined();
        anchor.mockReturnValue({isCollapsed: true, rangeCount: 1});
        expect(readPageRuleSelection(document)).toBeUndefined();
        anchor.mockReturnValue({isCollapsed: false, rangeCount: 0});
        expect(readPageRuleSelection(document)).toBeUndefined();
        anchor.mockReturnValue({isCollapsed: false, rangeCount: 1, getRangeAt: () => ({startContainer: target, startOffset: 1})});
        expect(readPageRuleSelection(document)).toBe(target.lastChild);
        anchor.mockReturnValue({isCollapsed: false, rangeCount: 1, getRangeAt: () => ({startContainer: start, startOffset: 2})});
        expect(readPageRuleSelection(document)).toBe(start);
    });

    it('reports live URL/scope matches, descendants excluded by a rule, protected slots and focus boundaries', () => {
        const {document, start, diagnose} = fixture();
        expect(diagnose(undefined, 'content', undefined)).toEqual({scope: 'content', ruleIds: ['fixture'], selection: {reason: 'no-selection'}});
        expect(diagnose(start, 'content', undefined).selection).toEqual({reason: 'inactive', ruleId: 'fixture', detail: 'article'});
        expect(diagnose(document.querySelector('#exclude')!.firstChild!, 'content', undefined).selection)
            .toEqual({reason: 'rule-excluded', ruleId: 'fixture', detail: 'fixture:exclude'});
        expect(diagnose(document.querySelector('.label')!, 'content', undefined).selection)
            .toEqual({reason: 'rule-protected', ruleId: 'fixture'});
        expect(diagnose(document.querySelector('#hard')!, 'content', undefined).selection)
            .toEqual({reason: 'protected', detail: 'inherited-no-translate'});
        expect(diagnose(document.querySelector('code')!, 'content', undefined).selection.reason).toBe('protected');
        expect(diagnose(document.querySelector('#outside')!, 'content', undefined).selection)
            .toEqual({reason: 'rule-focus', ruleId: 'fixture'});
        expect(diagnose(document.createElement('p'), 'content', undefined).selection.reason).toBe('unrecognized');
        expect(diagnose(document.body.appendChild(document.createElement('div')), 'all', undefined).selection.reason)
            .toBe('unrecognized');
        expect(diagnose(start, 'all', undefined)).toMatchObject({scope: 'all', ruleIds: [], selection: {reason: 'inactive'}});
        vi.stubGlobal('location', new URL('https://other.test/article'));
        expect(diagnose(start, 'content', undefined).ruleIds).toEqual([]);
    });

    it('reports real owner state ahead of queue status and checks session results against current source', () => {
        const {target, start, candidate, session, diagnose, readSource, checkLanguage} = fixture();
        const reason = () => diagnose(start, 'all', session).selection.reason;
        expect(reason()).toBe('unscheduled');
        session.scheduled.set(target, candidate);
        expect(reason()).toBe('waiting');
        session.inFlightCandidates.set(target, candidate);
        expect(reason()).toBe('loading');
        state.read.mockReturnValue({phase: 'error'});
        expect(reason()).toBe('error');
        state.read.mockReturnValue({phase: 'translated'});
        expect(reason()).toBe('translated');
        state.owner.mockReturnValueOnce(null);
        expect(reason()).toBe('loading');
        state.read.mockReset();
        session.inFlightCandidates.clear();
        session.scheduled.clear();
        session.userCancelledCandidates.set(start, source);
        expect(reason()).toBe('restored');
        session.unchangedCandidates.set(target, createLifecycleRetry(candidate, source, 0));
        readSource.mockReturnValueOnce('Different current text');
        expect(reason()).toBe('unscheduled');
        session.userCancelledCandidates.delete(start);
        expect(reason()).toBe('unchanged');
        checkLanguage.mockReturnValueOnce(true);
        expect(reason()).toBe('language-filtered');
        expect(checkLanguage).toHaveBeenLastCalledWith(expect.objectContaining({element: target}), session.translationConfig);
        expect(diagnose(start, 'all', session).scope).toBe('content');
        expect(JSON.stringify(diagnose(start, 'content', session))).not.toContain(source);
    });

    it('validates rendered ownership using state instead of trusting a page marker', () => {
        const {document, diagnose} = fixture();
        const wrapper = document.querySelector('.fluent-read-bilingual-content')!;
        expect(diagnose(wrapper, 'content', undefined).selection).toEqual({reason: 'protected', detail: 'fluentread-owned'});
        state.read.mockImplementation(ancestor => ancestor.id === 'owner' ? {phase: 'translated'} : undefined);
        expect(diagnose(wrapper.firstChild!, 'content', undefined).selection.reason).toBe('translated');
        state.read.mockReset();
        let inner = wrapper;
        for (let index = 0; index < 516; index += 1) {
            const parent = document.createElement('div');
            inner.replaceWith(parent);
            parent.append(inner);
            inner = parent;
        }
        expect(diagnose(wrapper, 'content', undefined).selection.reason).toBe('protected');
    });
});

import {parseHTML} from 'linkedom';
import {statefulSourceAndTextSlotsAreCurrent} from '@/src/features/full-page-translation/content/translationStability';
import {describe, expect, it} from 'vitest';
import {inlineCodeReplaySourceIsCurrent, type TranslationState} from '@/src/features/full-page-translation/content/state';

function fixture() {
    const {document} = parseHTML('<html><body><p>Use <code>fetch()</code> before <code>parse()</code> now.</p></body></html>');
    const style = {display: 'inline', visibility: 'visible', contentVisibility: 'visible', opacity: '1', whiteSpace: 'normal',
        fontFamily: 'Arial', position: 'static', overflow: 'visible', width: '20px', height: '20px', clip: 'auto', clipPath: 'none'};
    Object.defineProperty(document.defaultView, 'getComputedStyle', {configurable: true, value: () => style});
    const owner = document.querySelector('p') as unknown as HTMLElement;
    const state = {mode: 'bilingual', kind: 'content', phase: 'translated', bilingualReplay: {
        sources: ['Use', 'before', 'now.'], translations: ['使用', '之前', '现在。'],
        inlineCodeTexts: ['fetch()', 'parse()'], inlineCodeClasses: [null, null], inlineCodeSourceTexts: ['Use ', ' before ', ' now.'],
        targetLanguage: 'zh-Hans', style: 1,
    }} as unknown as TranslationState;
    return {document, owner, state, style};
}

describe('inline code whole-sentence replay source', () => {
    it('accepts the bound source and rejects code changes, movement, extra attributes and non-owned additions', () => {
        const f = fixture();
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(true);
        const first = f.owner.querySelector('code')!;
        first.textContent = 'changed()';
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        expect(statefulSourceAndTextSlotsAreCurrent(f.owner, f.state)).toBe(false);
        first.textContent = 'fetch()';
        first.setAttribute('title', 'new');
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        first.removeAttribute('title');
        f.owner.appendChild(first);
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
    });

    it('rechecks text, source visibility and ancestor protection before replay', () => {
        const f = fixture();
        f.owner.firstChild!.nodeValue = 'Choose ';
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        f.owner.firstChild!.nodeValue = 'Use ';
        f.owner.firstChild!.nodeValue = 'Use';
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        f.owner.firstChild!.nodeValue = 'Use ';
        f.document.body.classList.add('sr-only');
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        f.document.body.classList.remove('sr-only');
        f.style.whiteSpace = 'pre-wrap';
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
    });

    it('binds notranslate code class exactly and rejects changed or additional attributes', () => {
        const f = fixture();
        const code = f.owner.querySelector('code')!;
        code.setAttribute('class', 'notranslate');
        f.state.bilingualReplay!.inlineCodeClasses = ['notranslate', null];
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(true);
        code.removeAttribute('class');
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        code.setAttribute('class', 'notranslate');
        code.setAttribute('title', 'changed');
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        f.state.bilingualReplay!.inlineCodeClasses = new Array(2);
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
    });

    it('recognizes only registered single-mode hosts in their exact order', () => {
        const f = fixture();
        const texts = Array.from(f.owner.childNodes).filter(node => node.nodeType === 3) as Text[];
        const hosts = texts.map(source => {
            const host = f.document.createElement('span') as unknown as HTMLElement;
            host.className = 'fluent-read-single-slot';
            host.setAttribute('data-fr-translation-owned', 'true');
            host.setAttribute('translate', 'no');
            source.parentNode!.insertBefore(host, source);
            host.appendChild(source);
            return {host, source, sourceValue: source.data};
        });
        f.state.mode = 'single';
        f.state.singleTextSlotHosts = hosts;
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(true);
        f.owner.querySelector('code')!.textContent = 'changed()';
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
        f.owner.querySelector('code')!.textContent = 'fetch()';
        f.state.singleTextSlotHosts = [...hosts].reverse();
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(false);
    });

    it('leaves existing non-protocol replay paths unchanged', () => {
        const f = fixture();
        delete f.state.bilingualReplay!.inlineCodeTexts;
        delete f.state.bilingualReplay!.inlineCodeClasses;
        delete f.state.bilingualReplay!.inlineCodeSourceTexts;
        f.owner.innerHTML = '<p>arbitrary content</p>';
        expect(inlineCodeReplaySourceIsCurrent(f.owner, f.state)).toBe(true);
    });
});

/** Amazon 价格与评分的受控证据投影：真实核心/快照/渲染器保留骨架，完整可译正文仍必须被编码。 */
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {compileSiteRulePack} from '@/src/core/site-adaptation/compiler';
import {createTranslationSourceSnapshot, applyTranslationsToSnapshot} from '@/src/core/translation/serialization';
import {appendBilingualTranslation} from '@/src/features/full-page-translation/content/renderer';
import {createTranslationCore} from './helpers/translationCore';

vi.mock('@/src/services/config/store', () => ({config: {style: 1, to: 'zh-Hans'}}));
vi.mock('@/src/core/config/catalog', () => ({options: {styles: []}}));
vi.mock('@/src/features/full-page-translation/content/layout', () => ({ensureTranslationTruncationLayout: vi.fn()}));
const require = createRequire(import.meta.url);
const {encodeControlledTranslation, readControlledPageEvidenceInPage, assertControlledPageEvidence,
    captureSourcePartitions, assertSourcePartitions} = require('../scripts/site-translation/controlled-provider.cjs');
const url = 'https://www.amazon.com/dp/B09B8V1LZ3?language=en_US&th=1';

function fixture() {
    const {document, window} = parseHTML(`<html><body><main>
      <p id="price-owner">3 offers from <a href="/gp/offer-listing/B09B8V1LZ3"><span class="a-price" data-a-size="medium_plus" data-a-color="base"><span class="a-offscreen">JPY12,997</span><span aria-hidden="true"><span class="a-price-symbol">JPY</span><span class="a-price-whole">12,997</span></span></span></a> with delivery options.</p>
      <p id="rating-owner">Rated <a id="acrPopover" href="#customerReviews"><span>4.5 out of 5 stars</span></a> by readers.</p>
      <p id="ordinary-owner">An ordinary <span class="a-price-example">price comparison explanation</span> and <span id="acrPopover-example">rating explanation</span> must remain translatable.</p>
    </main></body></html>`);
    Object.defineProperty(document, 'baseURI', {value: url});
    vi.stubGlobal('document', document); vi.stubGlobal('Node', window.Node); vi.stubGlobal('location', new URL(url));
    const core = createTranslationCore({url: new URL(url)});
    const entries = ['price', 'rating', 'ordinary'].map(name => {
        const owner = document.querySelector<HTMLElement>(`#${name}-owner`)!;
        const snapshot = createTranslationSourceSnapshot(owner, core.shouldStayOriginal, undefined, undefined, core.shouldOmitFromTranslation);
        return {name, owner, snapshot};
    });
    const render = () => entries.map(entry => ({...entry,
        output: appendBilingualTranslation(entry.owner, applyTranslationsToSnapshot(entry.snapshot,
            entry.snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: entry.snapshot.clone}),
    }));
    return {document, core, entries, render};
}

afterEach(() => vi.unstubAllGlobals());

describe('Amazon 购物保护骨架的受控响应证据', () => {
    it('保留JPY原价和评分链接，同时为全部自然语言槽提供完整受控证据', async () => {
        const state = fixture();
        const production = builtinSiteRulePack.rules.find(rule => rule.id === 'amazon-shopping')!;
        expect(production.protect).toEqual(['.a-price', '#acrPopover']);
        for (const selector of production.protect!) expect(state.core.shouldStayOriginal(state.document.querySelector(selector)!)).toBe(true);
        expect(state.entries[0]!.snapshot.slots.map(slot => slot.source)).not.toContain('JPY12,997');
        expect(state.entries[1]!.snapshot.slots.map(slot => slot.source).join('')).not.toContain('4.5 out of 5 stars');
        expect(state.entries[2]!.snapshot.slots.map(slot => slot.source).join('')).toContain('price comparison explanation');
        const page = {evaluate: async (fn: (argument: unknown) => unknown, argument: unknown) => fn(argument)};
        const ledger = await captureSourcePartitions(page, [{name: 'offer', selector: '#price-owner', sourcePartition: {excludeSelectors: []}}]);
        const outputs = state.render();
        expect(outputs[0]!.output.querySelector('a span')!.textContent).toBe('JPY12,997');
        const evidence = readControlledPageEvidenceInPage();
        expect(evidence[0].source).toContain('3 offers from');
        expect(evidence[0].source).not.toContain('JPY12,997');
        expect(evidence[0].protectedMatches).toContainEqual(expect.objectContaining({
            tag: 'span', text: 'JPY12,997', href: null, linkHref: '/gp/offer-listing/B09B8V1LZ3', matched: true, elementOnly: true,
        }));
        expect(evidence[1].protectedMatches).toContainEqual(expect.objectContaining({
            tag: 'a', text: '4.5 out of 5 stars', href: '#customerReviews', linkHref: '#customerReviews', matched: true, elementOnly: true,
        }));
        // 原生价格同时包含无障碍文本与 aria-hidden 可视副本；生产快照保留前者，证据逐项记录后者的明确排除。
        expect(evidence.flatMap((row: any) => row.omittedParts)).toEqual([
            {tag: 'span', text: 'JPY12,997', reason: 'explicit-hidden-or-nonprose'},
        ]);
        expect(assertControlledPageEvidence(evidence, 'amazon-price')).toMatchObject({owners: 3, completeSourceMatched: true});
        await expect(assertSourcePartitions(page, ledger, 'translated')).resolves.toEqual([expect.objectContaining({completeSourceMatched: true})]);
        outputs.forEach(entry => entry.output.remove());
        await expect(assertSourcePartitions(page, ledger, 'restored', {restored: true})).resolves.toEqual([expect.objectContaining({restored: true})]);
    });

    it.each([
        'https://www.amazon.com/dp/B09B8V1LZ3', 'https://www.amazon.co.uk/dp/ASIN',
        'http://www.amazon.de/product-name/dp/ASIN?language=en_US#details', 'https://www.amazon.co.jp/gp/product/ASIN',
        'https://WWW.AMAZON.COM./gp/customer-reviews/REVIEW', 'https://www.amazon.com/a/b/dp/ASIN',
        'https://www.amazon.com//dp/', 'https://www.amazon.com:8443/dp/ASIN',
        'https://www.amazon.com/dp/', 'https://www.amazon.com/gp/product/',
        'https://www.amazon.com/gp/customer-reviews/',
        'https://www.amazon.com/dp', 'https://www.amazon.com/DP/ASIN',
        'https://www.amazon.com/s?k=example', 'https://www.amazon.com/gp/cart/view.html',
        'https://amazon.com/dp/ASIN', 'https://shop.www.amazon.com/dp/ASIN',
        'https://www.amazon.com.evil.test/dp/ASIN', 'https://ordinary.test/dp/ASIN',
        'ftp://www.amazon.com/dp/ASIN',
        ...['login', 'signin', 'signup', 'account', 'settings', 'checkout', 'auth'].map(path => `https://www.amazon.com/${path}/nested/dp/ASIN`),
    ])('证据保护范围与生产adapter完全一致：%s', raw => {
        const state = fixture(); state.render();
        const current = new URL(raw); vi.stubGlobal('location', current);
        const adapter = compileSiteRulePack(builtinSiteRulePack).find(item => item.id === 'amazon-shopping')!;
        const evidence = readControlledPageEvidenceInPage();
        const protectedParts = evidence.flatMap((row: any) => row.protectedMatches).filter((part: any) => part.elementOnly);
        expect(protectedParts).toHaveLength(adapter.matches(current) ? 2 : 0);
        if (adapter.matches(current)) expect(assertControlledPageEvidence(evidence, raw)).toMatchObject({owners: 3});
        else expect(() => assertControlledPageEvidence(evidence, raw)).toThrow('complete source');
    });

    it.each(['changed-price', 'missing-price', 'unwrapped-price', 'changed-offer-link', 'missing-offer-link',
        'changed-rating', 'missing-rating', 'changed-rating-link', 'extra-price', 'extra-prose', 'extra-encoded-prose',
        'untranslated-prose', 'missing-natural-language-slot', 'changed-native-price'])(
        '拒绝受保护骨架或自然语言正文不完整：%s', variant => {
            const state = fixture(), rendered = state.render();
            const price = rendered[0]!.output.querySelector('a span')!;
            const rating = rendered[1]!.output.querySelector('a')!;
            if (variant === 'changed-price') price.textContent = 'JPY0';
            if (variant === 'missing-price') price.remove();
            if (variant === 'unwrapped-price') price.replaceWith(state.document.createTextNode(price.textContent!));
            if (variant === 'changed-offer-link') price.closest('a')!.setAttribute('href', '/different-offer');
            if (variant === 'missing-offer-link') price.closest('a')!.removeAttribute('href');
            if (variant === 'changed-rating') rating.textContent = '5 out of 5 stars';
            if (variant === 'missing-rating') rating.remove();
            if (variant === 'changed-rating-link') rating.setAttribute('href', '#different-reviews');
            if (variant === 'extra-price') rendered[0]!.output.append(price.cloneNode(true));
            if (variant === 'extra-prose') rendered[0]!.output.append('Unexpected literal prose.');
            if (variant === 'extra-encoded-prose') rendered[0]!.output.append(encodeControlledTranslation('Unexpected extra paragraph.'));
            if (variant === 'untranslated-prose') rendered[0]!.output.firstChild!.textContent = state.entries[0]!.snapshot.slots[0]!.source;
            if (variant === 'missing-natural-language-slot') rendered[0]!.output.firstChild!.textContent = '';
            if (variant === 'changed-native-price') state.document.querySelector('.a-price')!.textContent = 'JPY13,500';
            expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), variant)).toThrow('complete source');
        });

    it('不把近似价格类名中的普通说明当成原文豁免', () => {
        const state = fixture(), rendered = state.render(), ordinary = rendered[2]!;
        expect(state.core.shouldStayOriginal(state.document.querySelector('.a-price-example')!)).toBe(false);
        expect(state.core.shouldStayOriginal(state.document.querySelector('#acrPopover-example')!)).toBe(false);
        ordinary.output.querySelector('span')!.textContent = 'price comparison explanation';
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'ordinary-echo')).toThrow('complete source');
    });

    it('空的原生价格节点仍须在译文骨架中存在', () => {
        const state = fixture();
        state.document.querySelector('.a-price')!.textContent = '';
        const price = state.entries[0]!;
        const snapshot = createTranslationSourceSnapshot(price.owner, state.core.shouldStayOriginal, undefined, undefined, state.core.shouldOmitFromTranslation);
        const output = appendBilingualTranslation(price.owner, applyTranslationsToSnapshot(snapshot,
            snapshot.slots.map(slot => encodeControlledTranslation(slot.source))), {sourceSkeleton: snapshot.clone});
        expect(assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'empty-price')).toMatchObject({owners: 1});
        output.querySelector('a span')!.remove();
        expect(() => assertControlledPageEvidence(readControlledPageEvidenceInPage(), 'missing-empty-price')).toThrow('complete source');
    });
});

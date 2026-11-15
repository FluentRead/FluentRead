/**
 * @file tests/materialParagraphScan.test.ts
 * 文件职责：验证材料整页定位的完整性、同步预算和动态页面取消边界。
 * 主要内容：真实连接DOM、可控调度与样式计数，覆盖长文章、密集块、重复项、失效、取消和非空定位。
 * 模块边界：不联网、不模拟生产浏览器性能；计数上限与语义断言独立于运行耗时。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {MATERIAL_SCAN_LIMITS, scanMaterialParagraphs} from '@/src/features/vocabulary/materialParagraphScan';
import {createMaterialOriginalTextReadSession} from '@/src/features/vocabulary/materialOriginalText';

const quote = 'A unique original sentence near the end of the article.';
function dom(html: string) {
    const {document, window} = parseHTML(`<html><head></head><body><article>${html}</article></body></html>`);
    let reads = 0, duplicates = 0; const seen = new Set<Element>();
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => {reads++; if (seen.has(element)) duplicates++; seen.add(element); return element.style;});
    vi.stubGlobal('innerHeight', 800);
    return {document: document as unknown as Document, window, nextSlice: () => seen.clear(), counters: () => ({reads, duplicates})};
}
function scan(fixture: ReturnType<typeof dom>, request: Parameters<typeof scanMaterialParagraphs>[1], options: Parameters<typeof scanMaterialParagraphs>[2] = {}) {
    const tasks: Array<{run: () => void; cancelled: boolean}> = [];
    let settled = false;
    const pending = scanMaterialParagraphs(fixture.document, request, {...options, now: options.now ?? (() => 0), schedule(run) {
        const task = {run, cancelled: false}; tasks.push(task); return () => {task.cancelled = true;};
    }}).then(result => {settled = true; return result;});
    const step = async () => {
        const task = tasks.shift();
        if (task && !task.cancelled) {fixture.nextSlice(); task.run();}
        await Promise.resolve(); await Promise.resolve();
    };
    return {pending, step, queued: () => tasks.filter(task => !task.cancelled).length, async drain(afterStep?: () => void) {
        let turns = 0;
        while (!settled) {if (++turns > 20000) throw new Error('scan did not progress'); await step(); afterStep?.();}
        const result = await pending;
        expect(result.metrics.maxStylesPerSlice).toBeLessThanOrEqual(MATERIAL_SCAN_LIMITS.stylesPerSlice);
        expect(result.metrics.maxWorkPerSlice).toBeLessThanOrEqual(MATERIAL_SCAN_LIMITS.nodesPerSlice);
        expect(result.metrics.maxCharactersPerSlice).toBeLessThanOrEqual(MATERIAL_SCAN_LIMITS.charactersPerSlice);
        expect(result.metrics.maxCandidatesPerSlice).toBeLessThanOrEqual(MATERIAL_SCAN_LIMITS.candidatesPerSlice);
        expect(fixture.counters().duplicates).toBe(0);
        return result;
    }};
}
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('material paragraph scan', () => {
    it('cancels its native timeout before the first slice when the caller aborts', async () => {
        vi.useFakeTimers();const f=dom(`<p>${quote}</p>`),controller=new AbortController();
        const pending=scanMaterialParagraphs(f.document,{kind:'locate',locator:{kind:'text',quote}},{signal:controller.signal});
        expect(vi.getTimerCount()).toBe(1);controller.abort();
        expect((await pending).status).toBe('cancelled');expect(vi.getTimerCount()).toBe(0);
        await vi.runAllTimersAsync();expect(f.counters().reads).toBe(0);
    });
    it('finds captured source paragraphs in nested open shadow roots and observes their changes', async () => {
        const f = dom('<div id="outer"></div>');
        const outer = f.document.getElementById('outer')!.attachShadow({mode:'open'});
        outer.innerHTML = '<section id="inner"></section>';
        const inner = outer.getElementById('inner')!.attachShadow({mode:'open'});
        inner.innerHTML = `<p>${quote}</p>`;
        const paragraph = inner.querySelector('p')!;
        const located = await scan(f, {kind:'locate', locator:{kind:'text', quote}}).drain();
        expect(located.status).toBe('matched'); expect(located.node).toBe(paragraph);
        inner.innerHTML = Array.from({length:100}, (_, i) => `<p>${i === 99 ? quote : 'Original.'}</p>`).join('');
        f.nextSlice();
        const running = scan(f, {kind:'locate', locator:{kind:'text', quote}}); await running.step();
        inner.querySelector('p')!.textContent = 'Updated original.';
        expect((await running.drain()).status).toBe('invalidated');
    });

    it('covers paragraphs after 6000 with shared ancestor reads and retains the cursor across batch yields', async () => {
        const f = dom('<div>'.repeat(32) + Array.from({length: 6502}, (_, i) => `<p>${i === 6500 ? quote : `Original paragraph ${i} is readable source prose.`}</p>`).join('') + '</div>'.repeat(32));
        const result = await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}).drain();
        expect(result.status).toBe('matched'); expect(result.node).toBe(f.document.querySelectorAll('p')[6500]);
        expect(result.metrics.candidates).toBe(6502); expect(result.metrics.batchPauses).toBeGreaterThan(0);
        expect(result.metrics.styleReads).toBeLessThan(12000);
    });
    it('bounds dense blocks without truncating the rest of the document', async () => {
        const f = dom(`<p>${'<span></span>'.repeat(1998)}${quote}</p><p>Other paragraph.</p>`);
        const result = await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}).drain();
        expect(result.status).toBe('matched'); expect(result.metrics.maxStylesPerSlice).toBeGreaterThan(1900); expect(result.metrics.candidates).toBe(2);
    });
    it('does not turn unreadable oversized prose into proof of a unique match or an empty locator', async () => {
        const f = dom(`<p>${'x'.repeat(12001)}</p><p>${quote}</p>`);
        const result = await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}).drain();
        expect(result.status).toBe('incomplete'); expect(result.node).toBeUndefined(); expect(result.locator).toBeUndefined();
        const id = f.document.querySelectorAll('p')[1]; id.id = 'stable'; f.nextSlice();
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote, paragraphId: 'stable'}}).drain()).node).toBe(id);
    });
    it('keeps sibling ambiguity, overlapping quote ambiguity and duplicate IDs distinct from parent nesting', async () => {
        for (const html of [`<p>${quote}</p><p>${quote}</p>`, `<blockquote><p>${quote}</p><p>${quote}</p></blockquote>`, '<p>aaaaa</p>']) {
            const f = dom(html); expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote: html.includes('aaaaa') ? 'aaa' : quote}}).drain()).status).toBe('ambiguous');
        }
        const f = dom(`<p id="duplicate">${quote}</p><p id="duplicate">${quote}</p>`);
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote, paragraphId: 'duplicate'}}).drain()).status).toBe('ambiguous');
    });
    it('returns the narrow original block and validates both surrounding context and ID content', async () => {
        const f = dom('<blockquote><p id="source">First word and second word done.</p></blockquote>');
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote: 'word', prefix: 'second ', suffix: ' done.'}}).drain()).node?.tagName).toBe('P');
        f.nextSlice(); expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote: 'absent', paragraphId: 'source'}}).drain()).status).toBe('not-found');
    });
    it('invalidates the entire pass after text or ancestor style mutation, then observes fresh visibility', async () => {
        const f = dom(Array.from({length: 100}, (_, i) => `<p>${i === 99 ? quote : 'Original.'}</p>`).join(''));
        const running = scan(f, {kind: 'locate', locator: {kind: 'text', quote}}); await running.step();
        f.document.querySelector('p')!.textContent = quote;
        expect((await running.drain()).status).toBe('invalidated');
        f.nextSlice(); expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}).drain()).status).toBe('ambiguous');
        f.document.querySelector('article')!.style.display = 'none'; f.nextSlice();
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}).drain()).status).toBe('not-found');
    });
    it.each(['resize', 'load', 'transitionrun', 'animationstart', 'loadingdone'])('invalidates on %s and removes outstanding tasks', async type => {
        const f = dom(`<p>${quote}</p>`), fonts = f.document.createElement('div');
        Object.defineProperty(f.document, 'fonts', {value: fonts});
        const running = scan(f, {kind: 'locate', locator: {kind: 'text', quote}});
        if (type === 'resize') f.window.dispatchEvent(new f.window.Event(type));
        else if (type === 'loadingdone') fonts.dispatchEvent(new f.window.Event(type));
        else f.document.dispatchEvent(new f.window.Event(type));
        expect((await running.drain()).status).toBe('invalidated'); expect(running.queued()).toBe(0);
    });
    it('cancels queued and already-started work and rejects a stale owner before returning a result', async () => {
        const f = dom('<p>Original.</p>'), aborted = new AbortController(); aborted.abort();
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}, {signal: aborted.signal}).drain()).status).toBe('cancelled');
        const controller = new AbortController(), run = scan(f, {kind: 'locate', locator: {kind: 'text', quote}}, {signal: controller.signal}); controller.abort();
        expect((await run.drain()).status).toBe('cancelled'); expect(run.queued()).toBe(0);
        f.nextSlice(); expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}, {isCurrent: () => false}).drain()).status).toBe('stale');
        const next = new AbortController(); vi.stubGlobal('getComputedStyle', () => {next.abort(); return {display: 'block'};});
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote: 'Original.'}}, {signal: next.signal}).drain()).status).toBe('cancelled');
    });
    it('requires a live document and nonempty quote', async () => {
        const f = dom('');
        expect((await scanMaterialParagraphs({defaultView: null} as Document, {kind: 'viewport'})).status).toBe('stale');
        expect((await scanMaterialParagraphs({defaultView: f.window, documentElement: null} as unknown as Document, {kind: 'viewport'})).status).toBe('stale');
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text'}}).drain()).status).toBe('not-found');
    });
    it('viewport scan skips offscreen, hidden and short prose and saves only readable original text', async () => {
        const f = dom(`<p>Offscreen.</p><p hidden>Hidden source long enough to be saved.</p><p>short</p><p id="visible" class="notranslate">${quote}<code> getUserID</code><span class="fluent-read-bilingual-content">译文</span></p>`);
        for (const [i, p] of [...f.document.querySelectorAll('p')].entries()) p.getBoundingClientRect = () => ({top: i ? 10 : -100, bottom: i ? 50 : -50}) as DOMRect;
        const result = await scan(f, {kind: 'viewport'}).drain();
        expect(result.status).toBe('matched'); expect(result.locator).toEqual({kind: 'text', quote: quote + ' getUserID', paragraphId: 'visible'});
    });
    it('viewport movement, disconnected nodes and layout failures never yield a saved locator', async () => {
        let f = dom(`<p>${quote}</p>`), node = f.document.querySelector('p')!;
        node.getBoundingClientRect = () => {throw new Error('unavailable layout');};
        expect((await scan(f, {kind: 'viewport'}).drain()).status).toBe('incomplete');
        f = dom(`<p>${quote}</p>`); node = f.document.querySelector('p')!; let reads = 0;
        node.getBoundingClientRect = () => ({top: ++reads === 1 ? 10 : 900, bottom: reads === 1 ? 50 : 1000}) as DOMRect;
        expect((await scan(f, {kind: 'viewport'}).drain()).status).toBe('invalidated');
        f = dom(`<p>${quote}</p>`); const run = scan(f, {kind: 'viewport'}); f.document.dispatchEvent(new f.window.Event('scroll'));
        expect((await run.drain()).status).toBe('invalidated');
    });
    it('does not reuse cached styles across synchronous sessions and refuses closed or foreign sessions', () => {
        const f = dom(`<p>${quote}</p>`), paragraph = f.document.querySelector('p')!;
        const session = createMaterialOriginalTextReadSession(f.document); expect(session.project(paragraph)?.text).toBe(quote); session.close();
        expect(session.project(paragraph)).toBeUndefined(); expect(session.status).toBe('stale');
        paragraph.style.display = 'none'; f.nextSlice(); const next = createMaterialOriginalTextReadSession(f.document);
        expect(next.project(paragraph)).toBeUndefined(); expect(next.status).toBe('skipped'); next.close();
        const foreign = dom(`<p>${quote}</p>`); const other = createMaterialOriginalTextReadSession(f.document);
        expect(other.project(foreign.document.querySelector('p')!)).toBeUndefined(); expect(other.status).toBe('stale'); other.close();
    });
    it('rejects pending mutations and disconnects observed during final viewport layout reads', async () => {
        for (const detach of [true, false]) {
            const f = dom(`<p>${quote}</p>`), paragraph = f.document.querySelector('p')!; let reads = 0;
            paragraph.getBoundingClientRect = () => {
                if (++reads === 2) {if (detach) paragraph.remove(); else paragraph.setAttribute('data-changed', 'yes');}
                return {top: 10, bottom: 50} as DOMRect;
            };
            expect((await scan(f, {kind: 'viewport'}).drain()).status).toBe(detach ? 'stale' : 'invalidated');
        }
        const f = dom(`<p>${quote}</p>`); let changed = false;
        vi.stubGlobal('getComputedStyle', (node: HTMLElement) => {if (!changed) {changed = true; node.setAttribute('data-layout-read', 'changed');} return node.style;});
        expect((await scan(f, {kind: 'locate', locator: {kind: 'text', quote}}).drain()).status).toBe('invalidated');
    });
    it('counts cached ancestors in depth budgets and rejects partial projection after a descendant style error', () => {
        const f = dom('<div>'.repeat(59) + '<blockquote><div><p>Deep original.</p></div></blockquote>' + '</div>'.repeat(59));
        const session = createMaterialOriginalTextReadSession(f.document);
        expect(session.project(f.document.querySelector('blockquote')!)?.text).toBe('Deep original.');
        expect(session.project(f.document.querySelector('p')!)).toBeUndefined(); expect(session.status).toBe('budget-exceeded'); session.close();
        const next = dom('<p>Visible <i>Unreadable</i> tail.</p>');
        vi.stubGlobal('getComputedStyle', (node: HTMLElement) => {if (node.tagName === 'I') throw new Error('style unavailable'); return node.style;});
        const reader = createMaterialOriginalTextReadSession(next.document);
        expect(reader.project(next.document.querySelector('p')!)).toBeUndefined(); expect(reader.status).toBe('unavailable'); reader.close();
    });
    it('default task scheduling resolves a small scan without injected clock or scheduler', async () => {
        vi.useFakeTimers(); const f = dom(`<p>${quote}</p>`);
        const result = scanMaterialParagraphs(f.document, {kind: 'locate', locator: {kind: 'text', quote}});
        await vi.runAllTimersAsync(); expect((await result).status).toBe('matched');
    });
});

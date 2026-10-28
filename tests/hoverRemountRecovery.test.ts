import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import type {TranslationCandidate} from '@/src/core/translation/public';
import {trackXHoverRemount} from '@/src/features/full-page-translation/content/hoverRemountRecovery';

const URL_X = 'https://x.com/Alice/status/123';
const source = 'A carefully selected post about the Moon and the Earth.';
const articleHtml = (status = '/Alice/status/123', text = source, href = '/NASA') =>
    `<article><a data-base-ui-tooltip-trigger href="${status}">time</a><div class="post">${text} <a href="${href}">NASA</a></div></article>`;

type Callback = MutationCallback;
class MockObserver {
    static latest: MockObserver;
    readonly observe = vi.fn();
    readonly disconnect = vi.fn();
    private queued: MutationRecord[] = [];
    constructor(readonly callback: Callback) {MockObserver.latest = this;}
    emit(...records: MutationRecord[]): void {this.callback(records, this as unknown as MutationObserver);}
    enqueue(...records: MutationRecord[]): void {this.queued.push(...records);}
    takeRecords(): MutationRecord[] {return this.queued.splice(0);}
}

function record(target: Node, removed: readonly Node[], added: readonly Node[],
    previousSibling?: Node | null, nextSibling?: Node | null): MutationRecord {
    // 同条 replace 记录的默认边界来自已接入的新节点；需构造不一致证据时显式传入。
    const replacement = added.length === 1 && added[0]?.parentNode === target ? added[0] : undefined;
    return {type: 'childList', target, removedNodes: removed as unknown as NodeList,
        addedNodes: added as unknown as NodeList,
        previousSibling: previousSibling === undefined ? replacement?.previousSibling ?? null : previousSibling,
        nextSibling: nextSibling === undefined ? replacement?.nextSibling ?? null : nextSibling} as MutationRecord;
}

function fixture(url = URL_X) {
    const {document, window} = parseHTML(`<html><body><main>${articleHtml()}</main></body></html>`);
    const address = new URL(url);
    Object.defineProperty(document, 'location', {value: address, configurable: true});
    let currentViewDocument: Document = document as unknown as Document;
    const windowListeners: Array<[string, EventListener]> = [];
    const observedWindow = new Proxy(window, {get(target, property, receiver) {
        if (property === 'MutationObserver') return MockObserver;
        if (property === 'document') return currentViewDocument;
        if (property === 'addEventListener') return (type: string, listener: EventListener, options: boolean) => {
            windowListeners.push([type, listener]);
            return Reflect.get(target, property, receiver).call(receiver, type, listener, options);
        };
        return Reflect.get(target, property, receiver);
    }});
    Object.defineProperty(document, 'defaultView', {value: observedWindow, configurable: true});
    vi.stubGlobal('location', address);
    const documentListeners = vi.spyOn(document, 'addEventListener');
    const owner = document.querySelector<HTMLElement>('.post')!;
    const candidate: TranslationCandidate = {element: owner, kind: 'content', reason: 'paragraph'};
    const isCurrent = vi.fn(() => true);
    const onCancel = vi.fn();
    const tracking = trackXHoverRemount(candidate, 40, 30, isCurrent, onCancel);
    const observer = MockObserver.latest;
    const dispatchObserved = (type: string, event: Record<string, unknown>, target: 'document' | 'window' = 'document') => {
        const callback = target === 'document' ? documentListeners.mock.calls.find(([name]) => name === type)?.[1]
            : windowListeners.find(([name]) => name === type)?.[1];
        if (type === 'mousemove' && !callback) return;
        if (typeof callback !== 'function') throw new Error(`Missing ${type} listener`);
        callback.call(target === 'document' ? document : observedWindow, event as unknown as Event);
    };
    const makeHovered = (element: Element) => {
        const original = element.matches.bind(element);
        vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':hover' || original(selector));
    };
    const replaceArticle = (status = '/Alice/status/123', text = source, href = '/NASA') => {
        const old = document.querySelector('article')!;
        const parent = old.parentNode!;
        const next = document.createElement('article');
        next.innerHTML = articleHtml(status, text, href).replace(/^<article>|<\/article>$/gu, '');
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!;
        makeHovered(fresh);
        observer.emit(record(parent, [old], [next]));
        return {old, next, fresh};
    };
    return {document, window, address, owner, candidate, tracking, observer, isCurrent, onCancel, makeHovered, replaceArticle, dispatchObserved,
        replaceViewDocument: (next: Document) => {currentViewDocument = next;}};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('X hover request recovery at native remount', () => {
    it('identifies the original and observed replacement owners without claiming unrelated nodes', () => {
        const f = fixture();
        const unrelated = f.document.createElement('div');
        expect(f.tracking!.ownsOwner(f.owner)).toBe(true);
        expect(f.tracking!.ownsOwner(unrelated)).toBe(false);
        const {fresh} = f.replaceArticle();
        expect(f.tracking!.ownsOwner(f.owner)).toBe(true);
        expect(f.tracking!.ownsOwner(fresh)).toBe(true);
        expect(f.tracking!.ownsOwner(unrelated)).toBe(false);
        f.tracking!.cancel();
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
    });

    it('recognizes a replacement operated on before the queued same-batch callback', () => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        next.innerHTML = articleHtml().replace(/^<article>|<\/article>$/gu, '');
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!; f.makeHovered(fresh);
        f.observer.enqueue(record(parent, [old], [next]));
        expect(f.tracking!.ownsOwner(fresh)).toBe(true);
        f.tracking!.cancel();
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('recognizes a new owner before the second separated-batch callback without claiming another post', async () => {
        const f = fixture();
        const old = f.document.querySelector('main')!, parent = old.parentNode!;
        const unrelated = f.document.createElement('div');
        old.remove(); f.observer.enqueue(record(parent, [old], []));
        expect(f.tracking!.ownsOwner(unrelated)).toBe(false);
        expect(f.observer.disconnect).not.toHaveBeenCalled();
        const waiting = f.tracking!.waitForReplacement();
        const next = f.document.createElement('main'); next.innerHTML = articleHtml();
        parent.appendChild(next);
        const fresh = next.querySelector<HTMLElement>('.post')!; f.makeHovered(fresh);
        f.observer.enqueue(record(parent, [], [next]));
        expect(f.tracking!.ownsOwner(fresh)).toBe(true);
        expect(await waiting).toBe(true);
        f.tracking!.cancel();
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('matches one equivalent article replacement and releases all observation on finish', () => {
        const f = fixture();
        expect(f.tracking).not.toBeNull();
        const {fresh} = f.replaceArticle();
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
        expect(f.onCancel).toHaveBeenCalledOnce();
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('matches a whole main replacement when the same post and source are unique', () => {
        const f = fixture();
        const old = f.document.querySelector('main')!;
        const next = f.document.createElement('main');
        next.innerHTML = articleHtml();
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!;
        f.makeHovered(fresh);
        f.observer.emit(record(f.document.body, [old], [next]));
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it('matches a same-batch main replacement after the host dismantles the removed subtree', () => {
        const f = fixture();
        const old = f.document.querySelector('main')!;
        const oldArticle = old.querySelector('article')!;
        const next = f.document.createElement('main');
        next.innerHTML = articleHtml();
        old.replaceWith(next);
        oldArticle.remove();
        f.owner.remove();
        const fresh = next.querySelector<HTMLElement>('.post')!;
        f.makeHovered(fresh);
        // Observer callbacks run after all these edits: neither old root now contains owner.
        f.observer.emit(record(f.document.body, [old], [next]),
            record(old, [oldArticle], []), record(oldArticle, [f.owner], []));
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it.each(['different-post', 'different-link', 'duplicate-post', 'duplicate-source', 'route', 'cancel'] as const)(
        'does not recover a dismantled main with %s', reason => {
            const f = fixture();
            const old = f.document.querySelector('main')!;
            const oldArticle = old.querySelector('article')!;
            const next = f.document.createElement('main');
            next.innerHTML = articleHtml(reason === 'different-post' ? '/Mallory/status/999' : undefined,
                source, reason === 'different-link' ? '/different' : undefined);
            if (reason === 'duplicate-post') next.insertAdjacentHTML('beforeend', articleHtml());
            if (reason === 'duplicate-source') next.querySelector('article')!
                .insertAdjacentHTML('beforeend', `<div class="post">${source} <a href="/NASA">NASA</a></div>`);
            old.replaceWith(next); oldArticle.remove(); f.owner.remove();
            const fresh = next.querySelector('.post')!; f.makeHovered(fresh);
            if (reason === 'route') f.address.pathname = '/Bob/status/456';
            if (reason === 'cancel') f.tracking!.cancel();
            f.observer.emit(record(f.document.body, [old], [next]),
                record(old, [oldArticle], []), record(oldArticle, [f.owner], []));
            expect(f.tracking!.finish(true)).toBeNull();
        },
    );

    it('reconnects a dismantled main across batches only at its original parent and gap', async () => {
        const f = fixture();
        const old = f.document.querySelector('main')!;
        const oldArticle = old.querySelector('article')!;
        old.remove(); oldArticle.remove(); f.owner.remove();
        f.observer.emit(record(f.document.body, [old], []), record(old, [oldArticle], []));
        const waiting = f.tracking!.waitForReplacement();
        const next = f.document.createElement('main'); next.innerHTML = articleHtml();
        f.document.body.appendChild(next); f.makeHovered(next.querySelector('.post')!);
        f.observer.emit(record(f.document.body, [], [next]));
        expect(await waiting).toBe(true);
        expect(f.tracking!.finish(true)?.element).toBe(next.querySelector('.post'));
    });

    it('matches direct owner replacement inside the same article, ignoring unrelated prose', () => {
        const f = fixture();
        f.document.querySelector('article')!.insertAdjacentHTML('beforeend', '<div>Unrelated text.</div><article><a data-base-ui-tooltip-trigger href="/Bob/status/456">nested</a></article>');
        const parent = f.owner.parentNode!;
        const fresh = f.owner.cloneNode(true) as HTMLElement;
        f.owner.replaceWith(fresh); f.makeHovered(fresh);
        f.observer.emit(record(parent, [f.owner], [fresh]));
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it.each([
        ['/Mallory/status/999', source, '/NASA'],
        ['/Alice/status/123', 'The visible source changed.', '/NASA'],
        ['/Alice/status/123', source, '/different'],
    ])('rejects changed permalink, text or embedded link (%s / %s / %s)', (status, text, href) => {
        const f = fixture();
        f.replaceArticle(status, text, href);
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('rejects duplicate post identities and duplicate source owners', () => {
        for (const duplicate of ['post', 'source'] as const) {
            const f = fixture();
            const old = f.document.querySelector('article')!;
            const parent = old.parentNode!;
            const holder = f.document.createElement('div');
            holder.innerHTML = duplicate === 'post' ? articleHtml() + articleHtml() : articleHtml().replace('</article>', `<div class="post">${source} <a href="/NASA">NASA</a></div></article>`);
            const next = holder.firstElementChild!;
            old.replaceWith(next);
            if (duplicate === 'post') parent.appendChild(holder.firstElementChild!);
            const fresh = next.querySelector('.post')!;
            f.makeHovered(fresh);
            f.observer.emit(record(parent, [old], [next]));
            expect(f.tracking!.finish(true)).toBeNull();
        }
    });

    it('ignores unrelated mutations without recomputing request configuration', () => {
        const f = fixture();
        const other = f.document.createElement('aside');
        f.document.body.appendChild(other);
        for (let index = 0; index < 50; index++) f.observer.emit(record(other, [], [f.document.createElement('i')]));
        expect(f.isCurrent).not.toHaveBeenCalled();
        const {fresh} = f.replaceArticle();
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
        expect(f.isCurrent).toHaveBeenCalledTimes(2);
    });

    it('rejects source changes or lost hover after the replacement was observed', () => {
        for (const mutation of ['text', 'hover'] as const) {
            const f = fixture();
            const {fresh} = f.replaceArticle();
            if (mutation === 'text') fresh.firstChild!.textContent = 'Changed while waiting.';
            else vi.mocked(fresh.matches).mockImplementation(() => false);
            expect(f.tracking!.finish(true)).toBeNull();
        }
    });

    it('never retries non-stale outcomes or after configuration invalidation', () => {
        const a = fixture(); a.replaceArticle();
        expect(a.tracking!.finish(false)).toBeNull();
        const b = fixture(); b.replaceArticle(); b.isCurrent.mockReturnValue(false);
        expect(b.tracking!.finish(true)).toBeNull();
    });

    it('cancels when the route changes and can match a later batch at the same gap', async () => {
        const a = fixture(); a.replaceArticle(); a.address.pathname = '/Alice/status/999';
        expect(a.tracking!.finish(true)).toBeNull();
        const b = fixture();
        const old = b.document.querySelector('article')!, parent = old.parentNode!;
        old.remove(); b.observer.emit(record(parent, [old], []));
        const next = b.document.createElement('article'); next.innerHTML = articleHtml().replace(/^<article>|<\/article>$/gu, '');
        parent.appendChild(next); b.makeHovered(next.querySelector('.post')!);
        b.observer.emit(record(parent, [], [next]));
        expect(await b.tracking!.waitForReplacement()).toBe(true);
        expect(b.tracking!.finish(true)?.element).toBe(next.querySelector('.post'));
    });

    it('times out and releases a pending separated replacement exactly once', async () => {
        const f = fixture();
        const old = f.document.querySelector('main')!, parent = old.parentNode!;
        old.remove(); f.observer.emit(record(parent, [old], []));
        const waiting = f.tracking!.waitForReplacement();
        expect(f.tracking!.waitForReplacement()).toBe(waiting);
        vi.advanceTimersByTime(1_000);
        expect(await waiting).toBe(false);
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
        expect(f.onCancel).toHaveBeenCalledOnce();
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('fails closed if only a disconnected old ancestor removal was observed', async () => {
        const f = fixture();
        const oldMain = f.document.querySelector('main')!;
        const oldArticle = oldMain.querySelector('article')!;
        oldMain.remove(); oldArticle.remove();
        f.observer.emit(record(oldMain, [oldArticle], []));
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
        expect(await f.tracking!.waitForReplacement()).toBe(false);
    });

    it('retains both original sibling boundaries across separated main replacement', async () => {
        const f = fixture();
        const old = f.document.querySelector('main')!, parent = old.parentNode!;
        const previous = f.document.createElement('aside'), nextSibling = f.document.createElement('footer');
        parent.insertBefore(previous, old); parent.appendChild(nextSibling);
        old.remove(); f.observer.emit(record(parent, [old], [], previous, nextSibling));
        const waiting = f.tracking!.waitForReplacement();
        const next = f.document.createElement('main'); next.innerHTML = articleHtml();
        parent.insertBefore(next, nextSibling); f.makeHovered(next.querySelector('.post')!);
        f.observer.emit(record(parent, [], [next], previous, nextSibling));
        expect(await waiting).toBe(true);
        expect(f.tracking!.finish(true)?.element).toBe(next.querySelector('.post'));
    });

    it.each(['single-record', 'separate-records'] as const)(
        'accepts a same-batch replacement at both original sibling boundaries: %s', kind => {
            const f = fixture();
            const old = f.document.querySelector('main')!, parent = old.parentNode!;
            const previous = f.document.createElement('aside'), nextSibling = f.document.createElement('footer');
            parent.insertBefore(previous, old); parent.appendChild(nextSibling);
            const next = f.document.createElement('main'); next.innerHTML = articleHtml();
            old.remove(); parent.insertBefore(next, nextSibling); f.makeHovered(next.querySelector('.post')!);
            if (kind === 'single-record') f.observer.emit(record(parent, [old], [next], previous, nextSibling));
            else f.observer.emit(record(parent, [old], [], previous, nextSibling), record(parent, [], [next], previous, nextSibling));
            expect(f.tracking!.finish(true)?.element).toBe(next.querySelector('.post'));
        },
    );

    it.each(['post', 'source'] as const)('refuses to begin tracking when the original %s is already ambiguous', kind => {
        const f = fixture(); f.tracking!.cancel();
        if (kind === 'post') f.document.querySelector('main')!.insertAdjacentHTML('beforeend', articleHtml());
        else f.owner.parentElement!.appendChild(f.owner.cloneNode(true));
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
    });

    it.each(['another-article', 'nested-quote', 'another-main'] as const)(
        'retains global source uniqueness before tracking across %s, even with different post identities', kind => {
            const f = fixture(); f.tracking!.cancel();
            const other = articleHtml('/Bob/status/456');
            if (kind === 'another-article') f.document.querySelector('main')!.insertAdjacentHTML('beforeend', other);
            else if (kind === 'nested-quote') f.document.querySelector('article')!.insertAdjacentHTML('beforeend', other);
            else f.document.body.insertAdjacentHTML('beforeend', `<main>${other}</main>`);
            expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        },
    );

    it('still tracks when another main contains a different unique post and source', () => {
        const f = fixture(); f.tracking!.cancel();
        f.document.body.insertAdjacentHTML('beforeend', `<main>${articleHtml('/Bob/status/456', 'Different visible text.')}</main>`);
        const tracking = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent);
        expect(tracking).not.toBeNull();
        tracking?.cancel();
    });

    it.each(['malformed', 'many-links', 'many-candidates'] as const)(
        'rejects the initial document when unrelated %s exceed the original uniqueness boundary', kind => {
            const f = fixture(); f.tracking!.cancel();
            if (kind === 'malformed') f.document.body.insertAdjacentHTML('beforeend', '<a data-base-ui-tooltip-trigger href="http://[">bad</a>');
            else if (kind === 'many-links') f.document.body.insertAdjacentHTML('beforeend', '<a data-base-ui-tooltip-trigger href="/other">x</a>'.repeat(2049));
            else f.document.querySelector('main')!.insertAdjacentHTML('beforeend', `<article>${'<div></div>'.repeat(4097)}</article>`);
            expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        },
    );

    it('refuses initial candidates when identical text requires too many distinct structural identities', () => {
        const f = fixture(); f.tracking!.cancel();
        const main = f.document.querySelector('main')!;
        main.insertAdjacentHTML('beforeend', '<article>' + Array.from({length: 9}, (_, index) =>
            `<div>${source} <a href="/other-${index}">NASA</a></div>`).join('') + '</article>');
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
    });

    it('refuses the initial document when candidate text comparisons exhaust the shared character budget', () => {
        const f = fixture(); f.tracking!.cancel();
        const text = 'A'.repeat(50_000);
        f.owner.textContent = text;
        f.document.querySelector('main')!.insertAdjacentHTML('beforeend', '<article>' +
            Array.from({length: 6}, () => `<div>${'A'.repeat(49_999)}B</div>`).join('') + '</article>');
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
    });

    it.each(['same-batch', 'earlier-batch', 'earlier-parent-dismantled', 'same-batch-parent-dismantled'] as const)(
        'rejects an existing owner moved into the original gap: %s', kind => {
            const f = fixture();
            const main = f.document.querySelector('main')!, old = main.querySelector('article')!;
            const foreign = f.document.createElement('section');
            const holder = f.document.createElement('div');
            const existing = old.cloneNode(true) as HTMLElement;
            holder.appendChild(existing); foreign.appendChild(holder); main.appendChild(foreign);
            f.observer.emit(record(main, [], [foreign], old, null));
            const removeExisting = record(holder, [existing], [], null, null);
            const removeHolder = record(foreign, [holder], [], null, null);
            if (kind === 'earlier-batch') {
                existing.remove(); f.observer.emit(removeExisting);
            } else if (kind === 'earlier-parent-dismantled') {
                holder.remove(); f.observer.emit(removeHolder); existing.remove();
            } else if (kind === 'same-batch-parent-dismantled') {
                holder.remove(); existing.remove();
            } else existing.remove();
            old.remove(); main.insertBefore(existing, foreign);
            f.makeHovered(existing.querySelector('.post')!);
            const removal = record(main, [old], [], null, foreign);
            const addition = record(main, [], [existing], null, foreign);
            if (kind === 'same-batch') f.observer.emit(removal, removeExisting, addition);
            else if (kind === 'same-batch-parent-dismantled') f.observer.emit(removal, removeHolder, removeExisting, addition);
            else f.observer.emit(removal, addition);
            expect(f.tracking!.finish(true)).toBeNull();
        },
    );

    it.each(['transient-record', 'missing-transient-record'] as const)(
        'rejects a new owner containing an original descendant after dismantling: %s', kind => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const movedLink = f.owner.querySelector('a')!;
        const next = old.cloneNode(true) as HTMLElement;
        old.remove(); movedLink.remove(); next.querySelector('.post a')!.replaceWith(movedLink);
        parent.appendChild(next); f.makeHovered(next.querySelector('.post')!);
        const records = [record(parent, [old], []), ...(kind === 'transient-record' ? [record(f.owner, [movedLink], [])] : []),
            record(parent, [], [next])];
        f.observer.emit(...records);
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('rejects a replacement moved out of its saved gap after the initial match', () => {
        const f = fixture();
        const old = f.document.querySelector('main')!, parent = old.parentNode!;
        const previous = f.document.createElement('aside'), nextSibling = f.document.createElement('footer');
        parent.insertBefore(previous, old); parent.appendChild(nextSibling);
        const next = f.document.createElement('main'); next.innerHTML = articleHtml();
        old.replaceWith(next); f.makeHovered(next.querySelector('.post')!);
        f.observer.emit(record(parent, [old], [next], previous, nextSibling));
        parent.appendChild(next);
        f.observer.emit(record(parent, [next], [], previous, nextSibling), record(parent, [], [next], nextSibling, null));
        expect(f.tracking!.finish(true)).toBeNull();
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
    });

    it('consumes queued movement before finish even when the replacement has returned to its original gap', () => {
        const f = fixture();
        const {next} = f.replaceArticle();
        const parent = next.parentNode!, previous = next.previousSibling, nextSibling = next.nextSibling;
        const foreign = f.document.createElement('section'); f.document.body.appendChild(foreign);
        next.remove(); foreign.appendChild(next); next.remove(); parent.insertBefore(next, nextSibling);
        f.observer.enqueue(record(parent, [next], [], previous, nextSibling), record(foreign, [], [next], null, null),
            record(foreign, [next], [], null, null), record(parent, [], [next], previous, nextSibling));
        expect(f.tracking!.finish(true)).toBeNull();
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
    });

    it('accepts a queued new unrelated badge during finish without changing the source', () => {
        const f = fixture();
        const {next, fresh} = f.replaceArticle();
        const badge = f.document.createElement('span'); badge.textContent = 'New badge';
        next.appendChild(badge); f.observer.enqueue(record(next, [], [badge]));
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it('recognizes a queued same-gap replacement directly during finish', () => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = old.cloneNode(true) as HTMLElement;
        old.replaceWith(next); const fresh = next.querySelector('.post')!; f.makeHovered(fresh);
        f.observer.enqueue(record(parent, [old], [next]));
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it('rejects a queued detached replacement and does not process records after explicit cancel', () => {
        const f = fixture();
        const {next} = f.replaceArticle();
        const parent = next.parentNode!; next.remove();
        f.observer.enqueue(record(parent, [next], []));
        expect(f.tracking!.finish(true)).toBeNull();
        const g = fixture(); g.tracking!.cancel();
        const take = vi.spyOn(g.observer, 'takeRecords');
        g.observer.enqueue(record(g.document.body, [], [g.document.createElement('i')]));
        expect(g.tracking!.finish(true)).toBeNull();
        expect(take).not.toHaveBeenCalled();
    });

    it('keeps a valid replacement when a new unrelated badge is inserted inside it', () => {
        const f = fixture();
        const {next, fresh} = f.replaceArticle();
        const badge = f.document.createElement('span'); badge.textContent = 'New badge';
        next.appendChild(badge);
        f.observer.emit(record(next, [], [badge]));
        expect(f.observer.disconnect).not.toHaveBeenCalled();
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it('rejects a previously connected badge moved inside a valid replacement', () => {
        const f = fixture();
        const foreign = f.document.createElement('aside'), badge = f.document.createElement('span');
        foreign.appendChild(badge); f.document.body.prepend(foreign);
        f.observer.emit(record(f.document.body, [], [foreign], null, f.document.querySelector('main')));
        const {next} = f.replaceArticle();
        badge.remove(); next.appendChild(badge);
        f.observer.emit(record(foreign, [badge], []), record(next, [], [badge]));
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('rejects reinserting a new badge into a replacement after it was removed', () => {
        const f = fixture();
        const {next} = f.replaceArticle();
        const badge = f.document.createElement('span'); badge.textContent = 'Badge';
        next.appendChild(badge); f.observer.emit(record(next, [], [badge]));
        badge.remove(); f.observer.emit(record(next, [badge], []));
        next.appendChild(badge); f.observer.emit(record(next, [], [badge]));
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('cancels rather than retaining an unbounded removed subtree history', async () => {
        const f = fixture();
        const other = f.document.createElement('section');
        other.innerHTML = '<i></i>'.repeat(16_384);
        f.document.body.appendChild(other); other.remove();
        f.observer.emit(record(f.document.body, [other], []));
        expect(await f.tracking!.waitForReplacement()).toBe(false);
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
    });

    it('cancels when prior additions exactly consume the shared history before another root', async () => {
        const f = fixture();
        const large = f.document.createElement('section'), other = f.document.createElement('aside');
        large.innerHTML = '<i></i>'.repeat(16_383);
        f.document.body.append(large, other);
        f.observer.emit(record(f.document.body, [], [large, other]));
        expect(await f.tracking!.waitForReplacement()).toBe(false);
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
    });

    it.each(['pending', 'same-batch'] as const)(
        'cancels if unrelated added history exceeds its budget while %s', async kind => {
            const f = fixture();
            const old = f.document.querySelector('article')!, parent = old.parentNode!;
            const large = f.document.createElement('section');
            large.innerHTML = '<i></i>'.repeat(16_384);
            old.remove(); f.document.body.appendChild(large);
            const removal = record(parent, [old], []), addition = record(f.document.body, [], [large]);
            if (kind === 'pending') {f.observer.emit(removal); f.observer.emit(addition);}
            else f.observer.emit(removal, addition);
            expect(await f.tracking!.waitForReplacement()).toBe(false);
            expect(f.observer.disconnect).toHaveBeenCalledOnce();
        },
    );

    it.each(['wrong-gap', 'changed-previous', 'changed-next', 'extra-change', 'extra-removal', 'multiple-additions', 'moved-after-record'] as const)(
        'refuses an ambiguous same-batch replacement: %s', kind => {
            const f = fixture();
            const old = f.document.querySelector('main')!, parent = old.parentNode!;
            const previous = f.document.createElement('aside'), nextSibling = f.document.createElement('footer');
            parent.insertBefore(previous, old); parent.appendChild(nextSibling);
            const next = f.document.createElement('main'); next.innerHTML = articleHtml();
            old.remove(); parent.insertBefore(next, nextSibling); f.makeHovered(next.querySelector('.post')!);
            const unrelated = f.document.createElement('section');
            if (kind === 'wrong-gap' || kind === 'moved-after-record') parent.appendChild(next);
            const addition = record(parent, [], [next], kind === 'changed-previous' || kind === 'wrong-gap' ? nextSibling : previous,
                kind === 'changed-next' || kind === 'wrong-gap' ? null : nextSibling);
            const removal = record(parent, kind === 'extra-removal' ? [old, unrelated] : [old], [], previous, nextSibling);
            if (kind === 'multiple-additions') f.observer.emit(removal, record(parent, [], [next, unrelated], previous, nextSibling));
            else if (kind === 'extra-change') f.observer.emit(removal, addition, record(parent, [], [unrelated], nextSibling, null));
            else f.observer.emit(removal, addition);
            expect(f.tracking!.finish(true)).toBeNull();
            expect(f.observer.disconnect).toHaveBeenCalledOnce();
        },
    );

    it('cancels immediately when either saved boundary no longer bounds the original gap', async () => {
        for (const changed of ['previous', 'next'] as const) {
            const f = fixture();
            const old = f.document.querySelector('main')!, parent = old.parentNode!;
            const previous = f.document.createElement('aside'), next = f.document.createElement('footer');
            parent.insertBefore(previous, old); parent.appendChild(next);
            old.remove();
            (changed === 'previous' ? previous : next).remove();
            f.observer.emit(record(parent, [old], [], previous, next));
            expect(await f.tracking!.waitForReplacement()).toBe(false);
            expect(f.observer.disconnect).toHaveBeenCalledOnce();
        }
    });

    it.each(['view-document', 'parent-document'] as const)('refuses an inconsistent document: %s', async changed => {
            const f = fixture();
            const old = f.document.querySelector('main')!, parent = old.parentNode!;
            old.remove();
            const other = parseHTML('<html><body></body></html>').document;
            if (changed === 'view-document') f.replaceViewDocument(other as unknown as Document);
            else {
                Object.defineProperty(parent, 'ownerDocument', {configurable: true, value: other});
                Object.defineProperty(parent, 'isConnected', {configurable: true, value: true});
                expect(parent.ownerDocument).toBe(other);
            }
            f.observer.emit(record(parent, [old], []));
            expect(f.observer.disconnect).toHaveBeenCalledOnce();
            expect(await f.tracking!.waitForReplacement()).toBe(false);
    });

    it('keeps waiting for the same bounded window when the response precedes the removal', async () => {
        const f = fixture();
        const waiting = f.tracking!.waitForReplacement();
        const old = f.document.querySelector('main')!, parent = old.parentNode!;
        old.remove(); f.observer.emit(record(parent, [old], []));
        const next = f.document.createElement('main'); next.innerHTML = articleHtml();
        parent.appendChild(next); f.makeHovered(next.querySelector('.post')!);
        f.observer.emit(record(parent, [], [next]));
        expect(await waiting).toBe(true);
        expect(f.tracking!.finish(true)?.element).toBe(next.querySelector('.post'));
        expect(f.onCancel).toHaveBeenCalledOnce();
    });

    it('rejects separated replacements after timeout, explicit cancel, route or configuration change', async () => {
        for (const reason of ['timeout', 'cancel', 'route', 'config'] as const) {
            const f = fixture();
            const old = f.document.querySelector('main')!, parent = old.parentNode!;
            old.remove(); f.observer.emit(record(parent, [old], []));
            const waiting = f.tracking!.waitForReplacement();
            if (reason === 'timeout') vi.advanceTimersByTime(1_000);
            if (reason === 'cancel') f.tracking!.cancel();
            if (reason === 'route') f.address.pathname = '/Bob/status/456';
            if (reason === 'config') f.isCurrent.mockReturnValue(false);
            const next = f.document.createElement('main'); next.innerHTML = articleHtml();
            parent.appendChild(next); f.makeHovered(next.querySelector('.post')!);
            f.observer.emit(record(parent, [], [next]));
            expect(await waiting).toBe(false);
            expect(f.tracking!.finish(true)).toBeNull();
        }
    });

    it.each(['other-parent', 'gap-change', 'competing-removal', 'multiple-additions', 'different-post', 'different-link', 'duplicate'] as const)(
        'refuses ambiguous separated replacement: %s', async reason => {
            const f = fixture();
            const old = f.document.querySelector('main')!, parent = old.parentNode!;
            old.remove(); f.observer.emit(record(parent, [old], []));
            const waiting = f.tracking!.waitForReplacement();
            const next = f.document.createElement('main');
            next.innerHTML = articleHtml(reason === 'different-post' ? '/Bob/status/456' : undefined,
                source, reason === 'different-link' ? '/other' : undefined);
            if (reason === 'duplicate') next.insertAdjacentHTML('beforeend', articleHtml());
            const other = f.document.createElement('aside');
            if (reason === 'other-parent') {
                f.document.body.appendChild(other); other.appendChild(next);
                f.observer.emit(record(other, [], [next]));
                vi.advanceTimersByTime(1_000);
            } else {
                if (reason === 'gap-change') parent.appendChild(other);
                parent.appendChild(next);
                f.makeHovered(next.querySelector('.post')!);
                f.observer.emit(record(parent, reason === 'competing-removal' ? [other] : [],
                    reason === 'multiple-additions' ? [next, other] : [next], reason === 'gap-change' ? other : null));
            }
            expect(await waiting).toBe(false);
            expect(f.tracking!.finish(true)).toBeNull();
        },
    );

    it('cancels a pending observation explicitly and after its bounded timeout', () => {
        const a = fixture(); a.tracking!.cancel(); a.tracking!.cancel();
        expect(a.observer.disconnect).toHaveBeenCalledOnce();
        expect(a.onCancel).toHaveBeenCalledOnce();
        a.replaceArticle(); expect(a.tracking!.finish(true)).toBeNull();
        const b = fixture(); vi.advanceTimersByTime(30_000);
        expect(b.observer.disconnect).toHaveBeenCalledOnce();
        b.replaceArticle(); expect(b.tracking!.finish(true)).toBeNull();
    });

    it('allows a trusted small pointer movement within the hovered post before and after remount', () => {
        const f = fixture();
        f.dispatchObserved('mousemove', {isTrusted: true, clientX: 41, clientY: 30});
        expect(f.observer.disconnect).not.toHaveBeenCalled();
        const {fresh} = f.replaceArticle();
        f.dispatchObserved('mousemove', {isTrusted: true, clientX: 42, clientY: 30});
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it.each(['outside', 'other-post'] as const)('does not recover after pointer movement to %s', target => {
        const f = fixture();
        f.dispatchObserved('mousemove', {isTrusted: true, clientX: 250, clientY: 200});
        const {fresh} = f.replaceArticle();
        vi.mocked(fresh.matches).mockImplementation(() => false);
        if (target === 'other-post') {
            f.document.querySelector('main')!.insertAdjacentHTML('beforeend', articleHtml('/Bob/status/456', 'Other post.'));
            f.makeHovered(f.document.querySelectorAll('.post')[1]!);
        }
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it.each(['pointerdown', 'keydown', 'explicit'] as const)(
        'movement does not override subsequent %s cancellation', action => {
            const f = fixture();
            f.dispatchObserved('mousemove', {isTrusted: true, clientX: 41, clientY: 30});
            const {fresh} = f.replaceArticle();
            if (action === 'explicit') f.tracking!.cancel();
            else {
                const target = action === 'keydown' ? 'window' : 'document';
                f.dispatchObserved(action, {isTrusted: false}, target);
                expect(f.observer.disconnect).not.toHaveBeenCalled();
                f.dispatchObserved(action, {isTrusted: true}, target);
            }
            expect(f.observer.disconnect).toHaveBeenCalledOnce();
            expect(f.tracking!.finish(true)).toBeNull();
            expect(fresh.isConnected).toBe(true);
        },
    );

    it('a route event only cancels when the actual URL changed', () => {
        const f = fixture();
        f.dispatchObserved('fluentread-route-change', {});
        expect(f.observer.disconnect).not.toHaveBeenCalled();
        f.address.pathname = '/Bob/status/456';
        f.dispatchObserved('fluentread-route-change', {});
        expect(f.observer.disconnect).toHaveBeenCalledOnce();
    });

    it('rejects a replacement that detaches again, or an overly large mutation batch', () => {
        const a = fixture();
        const {fresh} = a.replaceArticle();
        fresh.remove();
        a.observer.emit(record(a.document.body, [fresh], []));
        expect(a.tracking!.finish(true)).toBeNull();
        const b = fixture();
        b.observer.emit(...Array.from({length: 129}, () => record(b.document.body, [], [])));
        expect(b.tracking!.finish(true)).toBeNull();
    });

    it('ignores updates after a successful replacement while retaining its identity check', () => {
        const f = fixture();
        const {fresh} = f.replaceArticle();
        f.observer.emit(record(f.document.body, [], [f.document.createElement('aside')]));
        expect(f.tracking!.finish(true)?.element).toBe(fresh);
    });

    it('rejects multiple removal records, a misleading connected removal and stale configuration', () => {
        const a = fixture();
        const old = a.document.querySelector('article')!, parent = old.parentNode!;
        old.remove();
        a.observer.emit(record(parent, [old], []), record(parent, [old], []));
        expect(a.tracking!.finish(true)).toBeNull();
        const b = fixture();
        const live = b.document.querySelector('article')!;
        b.observer.emit(record(live.parentNode!, [live], []));
        expect(b.tracking!.finish(true)).toBeNull();
        const c = fixture(); c.isCurrent.mockReturnValue(false); c.replaceArticle();
        expect(c.tracking!.finish(true)).toBeNull();
    });

    it('rejects replacement roots with a missing path, detached owner or a different document', () => {
        for (const reason of ['missing', 'detached', 'other-document'] as const) {
            const f = fixture();
            const old = f.document.querySelector('article')!, parent = old.parentNode!;
            const other = parseHTML(`<html><body>${articleHtml()}</body></html>`).document;
            const next = reason === 'other-document' ? other.querySelector('article')! : f.document.createElement('article');
            if (reason !== 'other-document') next.innerHTML = reason === 'missing' ? '<p>other</p>' : articleHtml().replace(/^<article>|<\/article>$/gu, '');
            old.remove();
            if (reason === 'missing') parent.appendChild(next);
            f.observer.emit(record(parent, [old], [next]));
            expect(f.tracking!.finish(true)).toBeNull();
        }
    });

    it('rejects an oversized number of candidate post elements and links', () => {
        const a = fixture();
        const old = a.document.querySelector('article')!, parent = old.parentNode!;
        const next = a.document.createElement('article');
        next.innerHTML = articleHtml().replace(/^<article>|<\/article>$/gu, '') + '<div></div>'.repeat(4097);
        old.replaceWith(next);
        a.makeHovered(next.querySelector('.post')!);
        a.observer.emit(record(parent, [old], [next]));
        expect(a.tracking!.finish(true)).toBeNull();
        const b = fixture(); b.tracking!.cancel();
        b.document.querySelector('article')!.insertAdjacentHTML('beforeend', '<a data-base-ui-tooltip-trigger href="/other">x</a>'.repeat(2049));
        expect(trackXHoverRemount(b.candidate, 40, 30, b.isCurrent)).toBeNull();
    });

    it('fails closed on a very wide document without querying an unbounded node list', () => {
        const f = fixture();
        const unrelated = f.document.createElement('section');
        unrelated.innerHTML = '<i></i>'.repeat(16_385);
        f.document.body.appendChild(unrelated);
        const query = vi.spyOn(f.document, 'querySelectorAll');
        f.replaceArticle();
        expect(f.tracking!.finish(true)).toBeNull();
        expect(query).not.toHaveBeenCalled();
    });

    it('shares an exhausted document budget across every added root', () => {
        const f = fixture();
        const section = f.document.createElement('section');
        section.innerHTML = '<i></i>'.repeat(16_385);
        f.document.body.insertBefore(section, f.document.body.firstChild);
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const first = f.document.createElement('article'), second = f.document.createElement('article');
        first.innerHTML = second.innerHTML = articleHtml().replace(/^<article>|<\/article>$/gu, '');
        old.replaceWith(first); parent.appendChild(second);
        f.observer.emit(record(parent, [old], [first, second]));
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('matches nested exact text without reading candidate textContent', () => {
        const f = fixture(); f.tracking!.cancel();
        f.owner.innerHTML = 'Carefully <span>selected <b>Moon</b></span> text.';
        const recovery = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)!;
        const observer = MockObserver.latest;
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        next.innerHTML = '<a data-base-ui-tooltip-trigger href="/Alice/status/123">time</a><div class="post">Carefully <span>selected <b>Moon</b></span> text.</div>';
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!;
        Object.defineProperty(fresh, 'textContent', {configurable: true, get: () => {throw new Error('unbounded read');}});
        f.makeHovered(fresh);
        observer.emit(record(parent, [old], [next]));
        expect(recovery.finish(true)?.element).toBe(fresh);
    });

    it('fails closed when near-matching nested text consumes the shared scan budget', () => {
        const f = fixture(); f.tracking!.cancel();
        const text = 'A'.repeat(50_000);
        f.owner.textContent = text;
        const recovery = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)!;
        const observer = MockObserver.latest;
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        next.innerHTML = '<a data-base-ui-tooltip-trigger href="/Alice/status/123">time</a>' +
            '<div class="post">' + text + '</div>' +
            Array.from({length: 6}, () => '<div><span>' + 'A'.repeat(49_999) + 'B</span></div>').join('');
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!;
        f.makeHovered(fresh);
        observer.emit(record(parent, [old], [next]));
        expect(recovery.finish(true)).toBeNull();
    });

    it('fails closed when too many text-identical but structurally different sources require inspection', () => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        next.innerHTML = '<a data-base-ui-tooltip-trigger href="/Alice/status/123">time</a>' +
            `<div class="post">${source} <a href="/NASA">NASA</a></div>` +
            Array.from({length: 9}, (_, index) => `<div>${source} <a href="/other-${index}">NASA</a></div>`).join('');
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!;
        f.makeHovered(fresh);
        f.observer.emit(record(parent, [old], [next]));
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it.each(['owned', 'tooltip', 'tooltip-class', 'script', 'protected-whitespace'] as const)(
        'does not treat duplicate source with %s as uniquely identifiable', kind => {
            const f = fixture(); f.tracking!.cancel();
            if (kind === 'protected-whitespace') f.owner.insertAdjacentHTML('beforeend', '<span class="notranslate">A   B</span>');
            if (kind === 'script') f.owner.insertAdjacentHTML('beforeend', '<script>old hidden script</script>');
            const recovery = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)!;
            const observer = MockObserver.latest;
            const old = f.document.querySelector('article')!, parent = old.parentNode!;
            const next = f.document.createElement('article');
            const original = f.owner.innerHTML;
            const extra = kind === 'owned' ? '<span data-fr-translation-owned="true">译文</span>'
                : kind === 'tooltip' ? '<span role="tooltip">different tooltip</span>'
                : kind === 'tooltip-class' ? '<span class="tooltip"><i class="tooltip-inner">different tooltip</i></span>' : '';
            const copy = kind === 'protected-whitespace' ? original.replace('A   B', 'A B')
                : kind === 'script' ? original.replace('old hidden script', 'different hidden script') : original + extra;
            next.innerHTML = '<a data-base-ui-tooltip-trigger href="/Alice/status/123">time</a>' +
                `<div class="post">${original}</div><div>${copy}</div>`;
            old.replaceWith(next);
            const fresh = next.querySelector<HTMLElement>('.post')!; f.makeHovered(fresh);
            observer.emit(record(parent, [old], [next]));
            expect(recovery.finish(true)).toBeNull();
        },
    );

    it('keeps an ordinary tooltip class with no tooltip-inner as source text', () => {
        const f = fixture(); f.tracking!.cancel();
        f.owner.insertAdjacentHTML('beforeend', '<span class="tooltip"><i>Visible prose</i></span>');
        const recovery = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)!;
        const observer = MockObserver.latest;
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        next.innerHTML = '<a data-base-ui-tooltip-trigger href="/Alice/status/123">time</a>' +
            `<div class="post">${f.owner.innerHTML}</div>`;
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!; f.makeHovered(fresh);
        observer.emit(record(parent, [old], [next]));
        expect(recovery.finish(true)?.element).toBe(fresh);
    });

    it('bounds tooltip child checks across the same replacement batch', () => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        const wideTooltip = '<div><span class="tooltip">' + '<i></i>'.repeat(6_500) + '</span></div>';
        next.innerHTML = '<a data-base-ui-tooltip-trigger href="/Alice/status/123">time</a>' +
            `<div class="post">${source} <a href="/NASA">NASA</a></div>` + wideTooltip.repeat(2);
        old.replaceWith(next);
        const fresh = next.querySelector<HTMLElement>('.post')!; f.makeHovered(fresh);
        f.observer.emit(record(parent, [old], [next]));
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('refuses a hidden oversized text subtree even if structural signing omits it', () => {
        const f = fixture(); f.tracking!.cancel();
        const script = f.document.createElement('script');
        script.textContent = 'x'.repeat(262_145);
        f.owner.appendChild(script);
        const walker = vi.spyOn(f.document, 'createTreeWalker');
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        expect(walker).not.toHaveBeenCalled();
    });

    it('checks replacement text budgets before collecting its source slots', () => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('article');
        next.innerHTML = articleHtml().replace(/^<article>|<\/article>$/gu, '');
        const fresh = next.querySelector<HTMLElement>('.post')!;
        const script = f.document.createElement('script');
        script.textContent = 'x'.repeat(262_145);
        fresh.appendChild(script);
        old.replaceWith(next); f.makeHovered(fresh);
        const walker = vi.spyOn(f.document, 'createTreeWalker');
        f.observer.emit(record(parent, [old], [next]));
        expect(f.tracking!.finish(true)).toBeNull();
        expect(walker).not.toHaveBeenCalled();
    });

    it('rejects overlong and cumulatively oversized permalink inputs before parsing', () => {
        for (const kind of ['href', 'base', 'aggregate'] as const) {
            const f = fixture(); f.tracking!.cancel();
            if (kind === 'href') f.document.querySelector('article a')!.setAttribute('href', '/' + 'x'.repeat(8192));
            if (kind === 'base') f.address.search = '?' + 'x'.repeat(8192);
            if (kind === 'aggregate') f.document.querySelector('article')!.insertAdjacentHTML('beforeend',
                `<a data-base-ui-tooltip-trigger href="/${'x'.repeat(1000)}">other</a>`.repeat(300));
            expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        }
    });

    it('does not track unsupported sites, control candidates or incomplete post identity', () => {
        const f = fixture(); f.tracking!.cancel();
        f.address.hostname = 'example.com';
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        f.address.hostname = 'x.com';
        expect(trackXHoverRemount({...f.candidate, kind: 'control'}, 40, 30, f.isCurrent)).toBeNull();
        f.document.querySelector('[data-base-ui-tooltip-trigger]')!.remove();
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
    });

    it('rejects incomplete candidate shapes, disconnected owners and ambiguous article ownership', () => {
        const f = fixture(); f.tracking!.cancel();
        expect(trackXHoverRemount({...f.candidate, nodes: [f.owner.firstChild!]}, 40, 30, f.isCurrent)).toBeNull();
        expect(trackXHoverRemount({...f.candidate, manualChunk: true}, 40, 30, f.isCurrent)).toBeNull();
        expect(trackXHoverRemount({...f.candidate, allowTopLevelApplicationShell: true}, 40, 30, f.isCurrent)).toBeNull();
        f.document.body.appendChild(f.owner);
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        f.owner.remove();
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
    });

    it('rejects malformed post links and source identities over the bounded structure budget', () => {
        const a = fixture(); a.tracking!.cancel();
        a.document.querySelector('article')!.insertAdjacentHTML('beforeend', '<a data-base-ui-tooltip-trigger href="http://[">bad</a>');
        expect(trackXHoverRemount(a.candidate, 40, 30, a.isCurrent)).toBeNull();
        const b = fixture(); b.tracking!.cancel();
        b.owner.textContent = 'a'.repeat(131_073);
        expect(trackXHoverRemount(b.candidate, 40, 30, b.isCurrent)).toBeNull();
    });

    it('rejects multiple post permalinks within the same article', () => {
        const f = fixture(); f.tracking!.cancel();
        f.document.querySelector('article')!.insertAdjacentHTML('beforeend',
            '<a data-base-ui-tooltip-trigger href="/Bob/status/456">other post</a>');
        expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
    });

    it('does not reuse a replacement when unrelated malformed or excessive post links prevent uniqueness', () => {
        for (const reason of ['malformed', 'excessive'] as const) {
            const f = fixture();
            f.document.body.insertAdjacentHTML('beforeend', reason === 'malformed'
                ? '<a data-base-ui-tooltip-trigger href="http://[">bad</a>'
                : '<a data-base-ui-tooltip-trigger href="/other">x</a>'.repeat(2049));
            f.replaceArticle();
            expect(f.tracking!.finish(true)).toBeNull();
        }
    });

    it('rejects a removed root without a recoverable owner path or an oversized addition batch', () => {
        const a = fixture();
        const other = a.document.createElement('aside');
        a.owner.remove();
        vi.spyOn(other, 'contains').mockReturnValue(true);
        a.observer.emit(record(a.document.body, [other], []));
        expect(a.tracking!.finish(true)).toBeNull();
        const b = fixture();
        const old = b.document.querySelector('article')!, parent = old.parentNode!;
        old.remove();
        b.observer.emit(record(parent, [old], Array.from({length: 129}, () => b.document.createElement('article'))));
        expect(b.tracking!.finish(true)).toBeNull();
    });

    it('limits total mutation nodes before copying or validating candidates', () => {
        const removed = fixture();
        const manyRemoved = Array.from({length: 129}, () => removed.document.createElement('i'));
        removed.observer.emit(record(removed.document.body, manyRemoved, []));
        expect(removed.observer.disconnect).toHaveBeenCalledOnce();
        expect(removed.isCurrent).not.toHaveBeenCalled();

        const added = fixture();
        const old = added.document.querySelector('article')!, parent = old.parentNode!;
        old.remove();
        const manyAdded = Array.from({length: 129}, () => added.document.createElement('article'));
        added.observer.emit(record(parent, [old], manyAdded.slice(0, 65)),
            record(parent, [], manyAdded.slice(65)));
        expect(added.observer.disconnect).toHaveBeenCalledOnce();
        expect(added.tracking!.finish(true)).toBeNull();
    });

    it('does not scan an oversized ancestor sibling list or an excessively deep post', () => {
        const wide = fixture(); wide.tracking!.cancel();
        const article = wide.document.querySelector('article')!;
        article.insertAdjacentHTML('beforeend', '<i></i>'.repeat(16_385));
        expect(trackXHoverRemount(wide.candidate, 40, 30, wide.isCurrent)).toBeNull();

        const deep = fixture(); deep.tracking!.cancel();
        for (let index = 0; index < 64; index++) {
            const wrapper = deep.document.createElement('section');
            deep.owner.replaceWith(wrapper); wrapper.appendChild(deep.owner);
        }
        expect(trackXHoverRemount(deep.candidate, 40, 30, deep.isCurrent)).toBeNull();
    });

    it('refuses ancestor snapshots if a connected host reports an incomplete or inconsistent parent chain', () => {
        const outside = fixture(); outside.tracking!.cancel();
        outside.document.body.appendChild(outside.document.querySelector('article')!);
        expect(trackXHoverRemount(outside.candidate, 40, 30, outside.isCurrent)).toBeNull();

        for (const mode of ['missing-parent', 'missing-child'] as const) {
            const f = fixture(); f.tracking!.cancel();
            const article = f.document.querySelector('article')!;
            vi.spyOn(f.owner, 'closest').mockReturnValue(article);
            vi.spyOn(article, 'contains').mockReturnValue(true);
            Object.defineProperty(f.owner, 'isConnected', {configurable: true, get: () => true});
            if (mode === 'missing-parent') Object.defineProperty(f.owner, 'parentNode', {configurable: true, get: () => null});
            else Object.defineProperty(article, 'childNodes', {configurable: true, get: () => []});
            expect(trackXHoverRemount(f.candidate, 40, 30, f.isCurrent)).toBeNull();
        }
    });

    it('does not match a replacement outside the corresponding article', () => {
        const f = fixture();
        const old = f.document.querySelector('article')!, parent = old.parentNode!;
        const next = f.document.createElement('div');
        next.innerHTML = articleHtml().replace(/^<article>|<\/article>$/gu, '');
        old.replaceWith(next);
        f.observer.emit(record(parent, [old], [next]));
        expect(f.tracking!.finish(true)).toBeNull();
    });

    it('uses a safe default cancellation callback', () => {
        const f = fixture(); f.tracking!.cancel();
        const recovery = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent);
        expect(recovery).not.toBeNull();
        expect(() => recovery!.cancel()).not.toThrow();
    });

    it('retains a bounded fallback if a host DOM exposes a null textContent', () => {
        const f = fixture(); f.tracking!.cancel();
        Object.defineProperty(f.owner, 'textContent', {configurable: true, get: () => null});
        const recovery = trackXHoverRemount(f.candidate, 40, 30, f.isCurrent);
        expect(recovery).not.toBeNull();
        recovery!.cancel();
    });
});

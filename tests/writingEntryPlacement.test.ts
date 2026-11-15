import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {placeWritingEntry, prepareWritingEntryHost} from '@/src/features/writing-assistant/entryPlacement';

function page(html: string) {
    return parseHTML(`<html><body>${html}</body></html>`).document;
}

describe('writing entry placement', () => {
    it('makes the host participate in normal inline/flex flow instead of becoming a fixed overlay', () => {
        const doc = page('<div class="actions"><button>Comment</button></div>');
        const host = doc.createElement('span');

        prepareWritingEntryHost(host);

        expect(host.style.position).toContain('static');
        expect(host.style.display).toContain('inline-flex');
        expect(host.style.flex).toContain('0 0 auto');
        expect(host.style.cssText).not.toContain('position: fixed');
    });

    it('places GitHub writing before the native Comment action', () => {
        const doc = page('<div class="actions"><button>Close issue</button><button id="comment">Comment</button></div>');
        const action = doc.querySelector<HTMLButtonElement>('#comment')!;
        const host = doc.createElement('span');

        expect(placeWritingEntry(action, host, 'github')).toBe(true);
        expect([...action.parentElement!.children].map(node => node.textContent)).toEqual(['Close issue', '', 'Comment']);
        expect(host.parentElement).toBe(action.parentElement);
    });

    it('places Gmail writing after the native send action', () => {
        const doc = page('<div class="actions"><button id="send">Send</button><button>Discard</button></div>');
        const action = doc.querySelector<HTMLButtonElement>('#send')!;
        const host = doc.createElement('span');

        expect(placeWritingEntry(action, host, 'gmail')).toBe(true);
        expect([...action.parentElement!.children].map(node => node.textContent)).toEqual(['Send', '', 'Discard']);
        const insert = vi.spyOn(action.parentElement!, 'insertBefore');
        expect(placeWritingEntry(action, host, 'gmail')).toBe(true);
        expect(insert).not.toHaveBeenCalled();
    });

    it('moves an existing host with a rerendered action row without duplicating it', () => {
        const doc = page('<div id="old"><button id="old-action">Comment</button></div><div id="new"><button id="new-action">Comment</button></div>');
        const oldAction = doc.querySelector<HTMLButtonElement>('#old-action')!;
        const newAction = doc.querySelector<HTMLButtonElement>('#new-action')!;
        const host = doc.createElement('span');

        expect(placeWritingEntry(oldAction, host, 'github')).toBe(true);
        expect(placeWritingEntry(newAction, host, 'github')).toBe(true);
        expect(doc.querySelectorAll('span')).toHaveLength(1);
        expect(host.parentElement?.id).toBe('new');
        expect(placeWritingEntry(newAction, host, 'github')).toBe(true);
        expect(doc.querySelectorAll('span')).toHaveLength(1);
    });

    it('does not touch a detached action', () => {
        const doc = page('<button id="comment">Comment</button>');
        const action = doc.querySelector<HTMLButtonElement>('#comment')!;
        const host = doc.createElement('span');
        action.remove();

        expect(placeWritingEntry(action, host, 'github')).toBe(false);
        expect(host.parentElement).toBeNull();
    });
});

// 本次关闭必须跨同一文档内的卸载/重新挂载保持，但新文档有独立模块实例。
it('keeps visit dismissal in document memory and starts fresh in a new document', async () => {
    const {vi} = await import('vitest');
    vi.resetModules();
    const session = await import('@/src/features/writing-assistant/entrySession');
    expect(session.isWritingDismissedForVisit()).toBe(false);
    session.dismissWritingForVisit(); expect(session.isWritingDismissedForVisit()).toBe(true);
    expect((await import('@/src/features/writing-assistant/entrySession')).isWritingDismissedForVisit()).toBe(true);
    vi.resetModules(); expect((await import('@/src/features/writing-assistant/entrySession')).isWritingDismissedForVisit()).toBe(false);
});

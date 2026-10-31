import {describe, expect, it, vi} from 'vitest';
import {createReadingAppearanceRuntime} from '@/src/features/reading-appearance/runtime';
import {normalizeReadingAppearanceSites, type ReadingAppearanceSites} from '@/src/core/config/readingAppearance';
import {Config, normalizeConfig} from '@/src/core/config/model';
function setup() {
    let href = 'https://news.example.com/article', enabled = true;
    let sites: ReadingAppearanceSites = {};
    const controller = {setEnabled: vi.fn(), dispose: vi.fn()};
    const persist = vi.fn(async (value: ReadingAppearanceSites) => {sites = value;});
    const runtime = createReadingAppearanceRuntime({href: () => href, enabled: () => enabled,
        sites: () => sites, persist, controller, documentToken: 'doc'});
    const get = () => runtime.handle({type: 'getReadingAppearanceState'});
    const set = async (font: unknown, remember?: unknown, documentToken?: unknown) => {
        const token = documentToken ?? (await get() as {documentToken?: string}).documentToken;
        return runtime.handle({type: 'setReadingAppearance', font, remember, documentToken: token});
    };
    return {runtime, get, set, controller, persist, setSites: (value: ReadingAppearanceSites) => {sites = value;},
        changeUrl: (value: string) => {href = value;}, navigate: (value: string) => {href = value; runtime.routeChanged();}, disable: () => {enabled = false; runtime.sync();}};
}
describe('reading appearance configuration', () => {
    it('defaults to no remembered websites and safely normalizes imported preferences', () => {
        expect(new Config().readingAppearanceSites).toEqual({});
        for (const value of [null, 1, [], 'system']) expect(normalizeReadingAppearanceSites(value)).toEqual({});
        expect(normalizeReadingAppearanceSites({'https://news.example.com/a': 'system', 'bad domain': 'system', 'other.com': 'download'})).toEqual({'example.com': 'system'});
        expect(normalizeConfig({readingAppearanceSites: {'example.com': 'original'}}).readingAppearanceSites).toEqual({'example.com': 'original'});
    });
});
describe('reading appearance page lifecycle', () => {
    it('applies page preview without persistence, restores and rejects stale or malformed commands', async () => {
        const h = setup();
        expect(await h.get()).toEqual({status: 'disabled'});
        h.runtime.activate();
        expect(await h.get()).toMatchObject({font: 'original', remembered: false, domain: 'example.com', documentToken: 'doc'});
        expect(await h.set('system')).toMatchObject({font: 'system'});
        expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
        expect(h.persist).not.toHaveBeenCalled();
        expect(await h.set('system', undefined, 'old')).toEqual({status: 'stale'});
        expect(await h.set('download')).toEqual({status: 'invalid'});
        expect(await h.set('system', 'yes')).toEqual({status: 'invalid'});
        expect(await h.runtime.handle({type: 'unknown'})).toEqual({status: 'invalid'});
        await h.set('original');
        expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
    });
    it('remembers only explicitly, clears preference, and follows config on the next page', async () => {
        const h = setup(); h.runtime.activate();
        expect(await h.set('system', true)).toMatchObject({remembered: true});
        expect(h.persist).toHaveBeenLastCalledWith({'example.com': 'system'});
        await h.set('original');
        h.navigate('https://news.example.com/article#part');
        expect(await h.get()).toMatchObject({font: 'original'});
        h.navigate('https://news.example.com/next');
        expect(await h.get()).toMatchObject({font: 'system'});
        expect(await h.set('system', false)).toMatchObject({font: 'system', remembered: false});
        h.navigate('https://news.example.com/third');
        expect(await h.get()).toMatchObject({font: 'original'});
        h.setSites({'example.com': 'system'}); h.runtime.sync();
        expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
        h.runtime.suspend(); expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
        h.runtime.activate(); expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
        h.disable(); expect(await h.get()).toEqual({status: 'disabled'});
        h.runtime.dispose(); expect(h.controller.dispose).toHaveBeenCalledOnce();
    });
    it('rejects commands queued before SPA navigation, including same-site saves', async () => {
        const h = setup(); h.runtime.activate();
        const previous = await h.get() as {documentToken: string};
        h.changeUrl('https://news.example.com/next'); // 消息先于路由通知抵达时也要拒绝
        expect(await h.set('system', true, previous.documentToken)).toEqual({status: 'stale'});
        expect(h.persist).not.toHaveBeenCalled();
        expect(await h.get()).toMatchObject({font: 'original'});
        expect(await h.set('system')).toMatchObject({font: 'system'});
    });
    it('does not report failed saves as successful or overwrite preview', async () => {
        const h = setup(); h.runtime.activate();
        h.persist.mockRejectedValueOnce(new Error('storage failure'));
        expect(await h.set('system', true)).toEqual({status: 'failed'});
        expect(await h.get()).toMatchObject({font: 'original', remembered: false});
        h.navigate('file:///tmp/article');
        expect(await h.set('system', true)).toEqual({status: 'unsupported'});
        expect(await h.set('system')).toMatchObject({font: 'system'});
    });
    it('blocks repeated saves and discards async response after navigation or disposal', async () => {
        for (const leave of ['navigation', 'disposal', 'disable', 'suspend']) {
            const h = setup(); h.runtime.activate();
            let finish!: () => void;
            h.persist.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
            const pending = h.set('system', true);
            expect(await h.set('original')).toEqual({status: 'busy'});
            if (leave === 'navigation') h.navigate('https://example.com/new');
            else if (leave === 'disposal') h.runtime.dispose();
            else if (leave === 'disable') h.disable();
            else h.runtime.suspend();
            finish(); expect(await pending).toEqual({status: 'stale'});
        }
    });
});


describe('reading appearance route and suspension ownership', () => {
    it.each(['#/article/1', '#!/article/1'])('resets previews and rejects old commands on %s navigation', async route => {
        const h = setup(); h.navigate(`https://example.com/${route}`); h.runtime.activate();
        const before = await h.get() as {documentToken: string};
        await h.set('system');
        h.changeUrl(`https://example.com/${route.replace('/1', '/2')}`);
        expect(await h.set('original', true, before.documentToken)).toEqual({status: 'stale'});
        expect(h.persist).not.toHaveBeenCalled();
        expect(await h.get()).toMatchObject({font: 'original', remembered: false});
        expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
    });
    it('preserves preview and token on ordinary anchors and identical route notifications', async () => {
        const h = setup(); h.runtime.activate(); await h.set('system');
        const before = await h.get();
        h.navigate('https://news.example.com/article#section');
        h.runtime.routeChanged();
        expect(await h.get()).toEqual(before);
        h.navigate('https://news.example.com/article#another');
        expect(await h.get()).toEqual(before);
    });
    it.each(['#/article/2', '#!/article/2'])('does not apply a pending old-page save to %s', async next => {
        const h = setup(); h.runtime.activate();
        let finish!: () => void;
        h.persist.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        const pending = h.set('system', true);
        await Promise.resolve(); await Promise.resolve();
        h.navigate(`https://news.example.com/${next}`);
        finish();
        expect(await pending).toEqual({status: 'stale'});
        expect(await h.get()).toMatchObject({font: 'original'});
    });
    it('suspend/reactivate invalidates pending responses and tokens without erasing the page preview', async () => {
        const h = setup(); h.runtime.activate(); await h.set('system');
        const before = await h.get() as {documentToken: string};
        let finish!: () => void;
        h.persist.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        const pending = h.set('original', true); await Promise.resolve(); await Promise.resolve();
        h.runtime.suspend(); h.runtime.suspend(); h.runtime.activate();
        finish(); expect(await pending).toEqual({status: 'stale'});
        expect(await h.get()).toMatchObject({font: 'system'});
        expect(await h.set('original', undefined, before.documentToken)).toEqual({status: 'stale'});
        expect(await h.set('original')).toMatchObject({font: 'original'});
    });
});

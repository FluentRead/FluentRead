import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {createSavedVideoPositionRestorer, createVideoSentenceLearningHost, getVideoLearningSource, type MutableVideoSentenceLearningProps} from '@/src/features/video-subtitle/content/sentenceLearningHost';

function fixture(markup = '<video></video>', href = 'https://x.com/reader/status/123') {
    const {document} = parseHTML(`<html><head><title>Video page</title></head><body>${markup}</body></html>`);
    const video = document.querySelector('video')! as HTMLVideoElement;
    Object.assign(video, {readyState: 1, duration: 60, currentTime: 0, pause: vi.fn()});
    return {document, video, location: new URL(href)};
}

function props(video: HTMLVideoElement): MutableVideoSentenceLearningProps {
    return {video, cues: [], platform: 'x', title: 'A video', sourceLanguage: 'en', targetLanguage: 'zh-CN', translate: async text => text};
}

describe('video learning source provenance', () => {
    it('keeps YouTube video identity and requires the actual sole video for an unwrapped X page', () => {
        const youtube = fixture(undefined, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&tracking=1');
        expect(getVideoLearningSource(youtube.video, youtube.location, youtube.document)).toEqual({platform: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Video page'});
        const invalidYoutube = fixture(undefined, 'https://youtube.com/watch');
        expect(getVideoLearningSource(invalidYoutube.video, invalidYoutube.location, invalidYoutube.document).sourceUrl).toBeUndefined();
        const x = fixture();
        expect(getVideoLearningSource(x.video, x.location, x.document).sourceUrl).toBe('https://x.com/reader/status/123');
        expect(getVideoLearningSource(x.video, new URL('https://x.com/home'), x.document).sourceUrl).toBeUndefined();
        expect(getVideoLearningSource(x.video, new URL('https://x.com/reader/status/123/video/2'), x.document).sourceUrl).toBeUndefined();
        const second = x.document.createElement('video') as HTMLVideoElement;
        expect(getVideoLearningSource(second, x.location, x.document).sourceUrl).toBeUndefined();
        x.document.body.appendChild(second);
        expect(getVideoLearningSource(x.video, x.location, x.document).sourceUrl).toBeUndefined();
    });

    it('accepts a single video only when all valid post candidates name the same status', () => {
        const single = fixture('<article><div data-testid="tweetText">A reliable title</div><a href="/reader/status/123">Time</a><a href="https://twitter.com/reader/status/123?tracking=1">Same post</a><a href="https://evil.test/reader/status/999">Invalid host</a><video></video></article>');
        expect(getVideoLearningSource(single.video, single.location, single.document)).toEqual({platform: 'x', sourceUrl: 'https://x.com/reader/status/123', title: 'A reliable title'});
        const indexed = fixture('<article><a href="/reader/status/123">Time</a><video></video></article>', 'https://x.com/reader/status/123/video/2');
        expect(getVideoLearningSource(indexed.video, indexed.location, indexed.document).sourceUrl).toBeUndefined();
        expect(getVideoLearningSource(indexed.video, new URL('https://x.com/reader/status/123'), indexed.document).sourceUrl).toBe('https://x.com/reader/status/123');
        expect(getVideoLearningSource(indexed.video, new URL('https://x.com/home'), indexed.document).sourceUrl).toBe('https://x.com/reader/status/123');
        const explicit = indexed.document.createElement('a'); explicit.href = '/reader/status/123/video/2';
        indexed.video.replaceWith(explicit); explicit.appendChild(indexed.video);
        expect(getVideoLearningSource(indexed.video, indexed.location, indexed.document).sourceUrl).toBe('https://x.com/reader/status/123/video/2');
        const linkedIndex = fixture('<article><a href="/reader/status/123">Time</a><a href="/reader/status/123/video/2">Unbound second media</a><video></video></article>');
        expect(getVideoLearningSource(linkedIndex.video, linkedIndex.location, linkedIndex.document).sourceUrl).toBeUndefined();
        single.document.querySelector('article')!.insertAdjacentHTML('beforeend', '<a href="/quoted/status/999">Quoted post</a>');
        expect(getVideoLearningSource(single.video, single.location, single.document).sourceUrl).toBeUndefined();
        const empty = fixture('<article><div data-testid="tweetText"></div><video></video></article>');
        expect(getVideoLearningSource(empty.video, empty.location, empty.document)).toEqual({platform: 'x', sourceUrl: undefined, title: 'Video page'});
        const broken = fixture('<article><a href="http://[/status/123">Broken</a><video></video></article>');
        expect(getVideoLearningSource(broken.video, broken.location, broken.document).sourceUrl).toBeUndefined();
        const long = fixture(`<article><div data-testid="tweetText">${'a'.repeat(400)}</div><a href="/reader/status/123">Post</a><video></video></article>`);
        expect(getVideoLearningSource(long.video, long.location, long.document).title).toHaveLength(300);
    });

    it('requires the current video ancestor for a multi-video post and preserves /video/N exactly', () => {
        const multiple = fixture('<article><a href="/reader/status/123/video/1"><video id="first"></video></a><a href="/reader/status/123/video/2"><video id="second"></video></a><a href="/quoted/status/999">Quote</a></article>');
        expect(getVideoLearningSource(multiple.video, multiple.location, multiple.document).sourceUrl).toBe('https://x.com/reader/status/123/video/1');
        const second = multiple.document.getElementById('second')! as HTMLVideoElement;
        expect(getVideoLearningSource(second, multiple.location, multiple.document).sourceUrl).toBe('https://x.com/reader/status/123/video/2');
        const ambiguous = fixture('<article><a href="/reader/status/123/video/1">Video link</a><video></video><video></video></article>');
        expect(getVideoLearningSource(ambiguous.video, ambiguous.location, ambiguous.document).sourceUrl).toBeUndefined();
        const invalid = fixture('<article><a href="https://evil.test/reader/status/123/video/1"><video></video></a><video></video></article>');
        expect(getVideoLearningSource(invalid.video, invalid.location, invalid.document).sourceUrl).toBeUndefined();
        const query = fixture('<article><a href="/reader/status/123?path=/video/2"><video></video></a></article>');
        expect(getVideoLearningSource(query.video, query.location, query.document).sourceUrl).toBe('https://x.com/reader/status/123');
    });
});

describe('learning panel mount ownership', () => {
    it('placement明确持有外部宿主时保留逻辑player，同步不会把原Vue挂载节点搬回', () => {
        const f = fixture('<div id="player"><video></video></div>'), player = f.document.getElementById('player')!;
        const frame = f.document.createElement('div'); f.document.body.appendChild(frame);
        const unmount = vi.fn(); let hostNode: HTMLElement;
        const syncPlayer = vi.fn();
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => unmount, place: node => {
            hostNode = node; frame.appendChild(node);
            return {syncPlayer, isConnected: target => target === player && node.parentElement === frame && frame.isConnected, destroy: () => frame.remove()};
        }});
        const current = props(f.video); host.open(player, current); expect(host.isConnected(player)).toBe(true); expect(current.player).toBe(player);
        expect(host.syncPlayer(player, f.video)).toBe(true); expect(syncPlayer).toHaveBeenCalledWith(player); expect(hostNode!.parentElement).toBe(frame);
        frame.remove(); expect(host.isConnected(player)).toBe(false); expect(host.syncPlayer(player, f.video)).toBe(false);
        host.close(); expect(unmount).toHaveBeenCalledOnce(); expect(hostNode!.isConnected).toBe(false);
    });

    it('returns focused mobile learning content to its same-video sibling entry after cleanup without taking external focus', () => {
        const f = fixture('<div id="player-container-id" class="player-container"><div id="movie_player" class="html5-video-player ytp-mweb-player"><video></video></div><ytm-custom-control><button id="fluent-read-video-subtitle-button"></button></ytm-custom-control></div><input id="outside">', 'https://m.youtube.com/watch?v=learning-focus');
        const player = f.document.getElementById('movie_player')!, entry = f.document.getElementById('fluent-read-video-subtitle-button')!;
        let active: Element | null = null;
        Object.defineProperty(f.document, 'activeElement', {get: () => active});
        const unmount = vi.fn(), entryFocus = vi.fn(() => {
            expect(host.isOpen()).toBe(false);
            expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
            expect(unmount).toHaveBeenCalledOnce();
        });
        entry.focus = entryFocus;
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount: element => {
            const section = f.document.createElement('section'); section.focus = vi.fn(() => {active = section;}); element.appendChild(section);
            return unmount;
        }});
        const current = props(f.video); current.platform = 'youtube';
        host.open(player, current); host.close();
        expect(entryFocus).toHaveBeenCalledOnce(); expect(entryFocus).toHaveBeenCalledWith({preventScroll: true});
        host.open(player, current); active = f.document.getElementById('outside'); host.close();
        expect(entryFocus).toHaveBeenCalledOnce(); expect(unmount).toHaveBeenCalledTimes(2);
    });

    it.each(['second-video', 'unknown-container', 'different-props-video', 'desktop', 'x'] as const)('does not return focus to an unowned sibling entry after %s changes its scope', mutation => {
        const f = fixture('<div id="player-container-id" class="player-container"><div id="movie_player" class="html5-video-player ytp-mweb-player"><video></video></div><ytm-custom-control><button id="fluent-read-video-subtitle-button"></button></ytm-custom-control></div>', 'https://m.youtube.com/watch?v=learning-focus');
        const player = f.document.getElementById('movie_player')!, scope = f.document.getElementById('player-container-id')!;
        const entry = f.document.getElementById('fluent-read-video-subtitle-button')!, focus = vi.fn(); entry.focus = focus;
        let active: Element | null = null;
        Object.defineProperty(f.document, 'activeElement', {get: () => active});
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount: element => {
            const section = f.document.createElement('section'); section.focus = vi.fn(() => {active = section;}); element.appendChild(section); return vi.fn();
        }});
        const current = props(f.video); current.platform = 'youtube'; host.open(player, current);
        if (mutation === 'second-video') scope.appendChild(f.document.createElement('video'));
        else if (mutation === 'unknown-container') scope.id = 'unrelated';
        else if (mutation === 'different-props-video') {
            const other = f.document.createElement('video'); f.document.body.appendChild(other); current.video = other;
        } else if (mutation === 'desktop') player.classList.remove('ytp-mweb-player');
        else {player.removeAttribute('id'); player.className = 'x-player'; current.platform = 'x';}
        host.close(); expect(focus).not.toHaveBeenCalled();
        expect(host.isOpen()).toBe(false); expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
    });

    it('delegates placement during mount and reparent, and disposes it even when Vue unmount fails', () => {
        const f = fixture('<div id="player"><div id="fullscreen"><video></video></div></div>');
        const player = f.document.getElementById('player')!; const fullscreen = f.document.getElementById('fullscreen')!;
        const syncPlayer = vi.fn(), destroy = vi.fn(), unmount = vi.fn(() => {throw new Error('Unmount failed');});
        const place = vi.fn(() => ({syncPlayer, destroy}));
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => unmount, place});
        host.open(player, props(f.video));
        expect(place).toHaveBeenCalledWith(f.document.getElementById('fluent-read-video-learning-panel'), player);
        expect(host.syncPlayer(fullscreen, f.video)).toBe(true); expect(syncPlayer).toHaveBeenCalledWith(fullscreen);
        expect(() => host.close()).toThrow('Unmount failed'); expect(destroy).toHaveBeenCalledOnce();
        expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
        const destroyFailed = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => vi.fn(), place: () => ({syncPlayer, destroy: () => {throw new Error('Placement failed');}})});
        destroyFailed.open(player, props(f.video)); expect(() => destroyFailed.close()).toThrow('Placement failed');
        expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
        const closeDuringPlacement = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => vi.fn(), place: () => {closeDuringPlacement.close(); return {syncPlayer, destroy};}});
        closeDuringPlacement.open(player, props(f.video)); expect(destroy).toHaveBeenCalledTimes(2); expect(closeDuringPlacement.isOpen()).toBe(false);
    });

    it('moves the same mounted panel across fullscreen containers while retaining props, drafts and focused controls', () => {
        const f = fixture('<div id="player"><div id="fullscreen"><video></video></div></div><div id="other"><video id="another"></video></div>');
        const player = f.document.getElementById('player')!;
        const fullscreen = f.document.getElementById('fullscreen')!;
        const unmount = vi.fn(); const focus = vi.fn(); const markUi = vi.fn();
        let active: Element | null = null;
        Object.defineProperty(f.document, 'activeElement', {get: () => active});
        const mount = vi.fn((element: HTMLElement) => {
            element.innerHTML = '<section><textarea>Retained manual draft</textarea></section>';
            const editor = element.querySelector<HTMLTextAreaElement>('textarea')!;
            editor.focus = focus; active = editor;
            return unmount;
        });
        const host = createVideoSentenceLearningHost({markUi, mount});
        expect(host.syncPlayer(player, f.video)).toBe(false);
        const current = props(f.video); host.open(player, current); expect(current.player).toBe(player);
        const panel = f.document.getElementById('fluent-read-video-learning-panel')!;
        expect(host.syncPlayer(fullscreen, f.video)).toBe(true);
        expect(current.player).toBe(fullscreen);
        expect(panel.parentElement).toBe(fullscreen); expect(host.isConnected(fullscreen)).toBe(true);
        expect(panel.querySelector('textarea')?.textContent).toBe('Retained manual draft');
        expect(focus).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledWith({preventScroll: true});
        expect(host.syncPlayer(fullscreen, f.video)).toBe(true); expect(focus).toHaveBeenCalledOnce();
        active = null;
        expect(host.syncPlayer(player, f.video)).toBe(true); expect(focus).toHaveBeenCalledOnce();
        expect(current.player).toBe(player);
        fullscreen.appendChild(panel); expect(host.isConnected()).toBe(false);
        expect(host.syncPlayer(player, f.video)).toBe(true); expect(host.isConnected(player)).toBe(true);
        expect(mount).toHaveBeenCalledOnce(); expect(unmount).not.toHaveBeenCalled(); expect(markUi).toHaveBeenCalledOnce();
        const other = f.document.getElementById('other')!;
        expect(host.syncPlayer(other, f.document.getElementById('another')! as HTMLVideoElement)).toBe(false);
        expect(host.syncPlayer(other, f.video)).toBe(false);
        expect(current.player).toBe(player);
        other.remove(); expect(host.syncPlayer(other, f.video)).toBe(false);
        f.video.remove(); expect(host.syncPlayer(player, f.video)).toBe(false);
        host.close(); expect(unmount).toHaveBeenCalledOnce();
    });

    it('marks, positions and focuses a panel, updates mutable cues and closes once across synchronous reentry', () => {
        const f = fixture('<div id="player"><video></video></div><div id="other"></div>');
        const player = f.document.getElementById('player')!;
        const other = f.document.getElementById('other')!;
        const focus = vi.fn(); const unmount = vi.fn(() => host.close());
        const markUi = vi.fn();
        const host = createVideoSentenceLearningHost({markUi, mount: (element, received) => {
            expect(received).toBe(currentProps);
            const section = f.document.createElement('section'); section.focus = focus; element.appendChild(section);
            return unmount;
        }});
        const currentProps = props(f.video);
        expect(host.isConnected()).toBe(false); expect(host.isOpen()).toBe(false); expect(host.hasCues()).toBe(false);
        host.updateCues([{text: 'Ignored.', startMs: 0, durationMs: 1000}], 'de');
        host.open(player, currentProps);
        expect(host.isConnected()).toBe(true); expect(host.isOpen()).toBe(true); expect(host.isConnected(player)).toBe(true); expect(host.isConnected(other)).toBe(false);
        expect(host.hasCues()).toBe(false); expect(focus).toHaveBeenCalledWith({preventScroll: true});
        const panel = f.document.getElementById('fluent-read-video-learning-panel')!;
        expect(markUi).toHaveBeenCalledWith(panel); expect(panel.style.position).toBe('absolute');
        const cues = [{text: 'A complete sentence.', startMs: 0, durationMs: 1000}]; host.updateCues(cues);
        expect(currentProps.cues).toBe(cues); expect(currentProps.sourceLanguage).toBe('en'); expect(host.hasCues()).toBe(true);
        host.updateCues(cues, 'fr'); expect(currentProps.sourceLanguage).toBe('fr');
        host.updateCues(cues, undefined); expect(currentProps.sourceLanguage).toBe('fr');
        other.appendChild(panel); expect(host.isConnected()).toBe(false);
        panel.remove(); expect(host.isConnected()).toBe(false);
        host.close(); host.close(); expect(unmount).toHaveBeenCalledTimes(1); expect(host.isOpen()).toBe(false); expect(host.hasCues()).toBe(false);
        host.updateCues([], 'de'); expect(currentProps.cues).toBe(cues); expect(currentProps.sourceLanguage).toBe('fr');
    });

    it('replaces old mounts, cleans up a failed mount and releases a mount that closes synchronously', () => {
        const f = fixture('<div id="player"><video></video></div>'); const player = f.document.getElementById('player')!;
        const first = vi.fn(); const second = vi.fn();
        const mount = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount});
        host.open(player, props(f.video)); host.open(player, props(f.video));
        expect(first).toHaveBeenCalledOnce(); expect(f.document.querySelectorAll('#fluent-read-video-learning-panel')).toHaveLength(1);
        host.close(); expect(second).toHaveBeenCalledOnce();
        const failing = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => {throw new Error('Cannot mount');}});
        expect(() => failing.open(player, props(f.video))).toThrow('Cannot mount');
        expect(failing.isConnected()).toBe(false); expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
        const immediateUnmount = vi.fn();
        const closing = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => {closing.close(); return immediateUnmount;}});
        closing.open(player, props(f.video)); expect(immediateUnmount).toHaveBeenCalledOnce(); expect(closing.isConnected()).toBe(false);
        const closingError = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => {closingError.close(); throw new Error('Closed mount');}});
        expect(() => closingError.open(player, props(f.video))).toThrow('Closed mount');
        expect(f.document.getElementById('fluent-read-video-learning-panel')).toBeNull();
    });

    it('removes the owned node when unmount throws and detects a detached player', () => {
        const f = fixture('<div id="player"><video></video></div>'); const player = f.document.getElementById('player')!;
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount: () => () => {throw new Error('Unmount failed');}});
        host.open(player, props(f.video)); player.remove(); expect(host.isConnected()).toBe(false);
        expect(() => host.close()).toThrow('Unmount failed'); expect(host.isConnected()).toBe(false);
        expect(player.querySelector('#fluent-read-video-learning-panel')).toBeNull(); host.close();
    });

    it('restores focus from the closed panel only to its connected entry without stealing a replacement panel focus', () => {
        const f = fixture('<div id="player"><button id="fluent-read-video-subtitle-button"></button><video></video></div><button id="outside"></button>');
        const player = f.document.getElementById('player')!;
        const entry = f.document.getElementById('fluent-read-video-subtitle-button')!;
        let active: Element | null = null;
        Object.defineProperty(f.document, 'activeElement', {get: () => active});
        const entryFocus = vi.fn(() => {
            expect(host.isOpen()).toBe(false);
            expect(player.querySelector('#fluent-read-video-learning-panel')).toBeNull();
        });
        entry.focus = entryFocus;
        let replaceDuringUnmount = false;
        const host = createVideoSentenceLearningHost({markUi: vi.fn(), mount: element => {
            const section = f.document.createElement('section');
            section.focus = vi.fn(() => {active = section;}); element.appendChild(section);
            return () => {
                host.close();
                if (replaceDuringUnmount) {replaceDuringUnmount = false; host.open(player, props(f.video));}
            };
        }});
        host.open(player, props(f.video)); host.close();
        expect(entryFocus).toHaveBeenCalledOnce(); expect(entryFocus).toHaveBeenCalledWith({preventScroll: true});
        host.open(player, props(f.video)); active = f.document.getElementById('outside'); host.close();
        expect(entryFocus).toHaveBeenCalledTimes(1);
        host.open(player, props(f.video)); entry.remove(); host.close();
        expect(entryFocus).toHaveBeenCalledTimes(1);
        player.appendChild(entry); host.open(player, props(f.video)); player.remove(); host.close();
        expect(entryFocus).toHaveBeenCalledTimes(1);
        f.document.body.appendChild(player); host.open(player, props(f.video)); replaceDuringUnmount = true; host.close();
        expect(host.isOpen()).toBe(true);
        expect(active).toBe(player.querySelector('#fluent-read-video-learning-panel section'));
        expect(entryFocus).toHaveBeenCalledTimes(1);
        active = null; host.close();
    });
});

describe('saved X video position restoration', () => {
    it('restores only the exact video identity once, preserves paused playback and accepts a new fragment or video instance', () => {
        const f = fixture('<article><a href="/reader/status/123/video/1"><video id="first"></video></a><a href="/reader/status/123/video/2"><video id="second"></video></a></article>', 'https://x.com/reader/status/123/video/2#fluentread-video=3000,5500');
        const second = f.document.getElementById('second')! as HTMLVideoElement; Object.assign(second, {readyState: 1, duration: 60, currentTime: 0, pause: vi.fn()});
        const restore = createSavedVideoPositionRestorer();
        expect(restore.restore(f.video, f.location, f.document)).toBe(false); expect(f.video.pause).not.toHaveBeenCalled();
        expect(restore.restore(second, f.location, f.document)).toBe(true); expect(second.currentTime).toBe(3); expect(second.pause).toHaveBeenCalledOnce();
        second.currentTime = 20;
        expect(restore.restore(second, f.location, f.document)).toBe(false); expect(second.currentTime).toBe(20);
        f.location.hash = '#fluentread-video=6000,8000'; expect(restore.restore(second, f.location, f.document)).toBe(true); expect(second.currentTime).toBe(6);
        const another = fixture('<a href="/reader/status/123/video/2"><video></video></a>', 'https://x.com/reader/status/123/video/2#fluentread-video=3000,5500');
        expect(restore.restore(another.video, another.location, another.document)).toBe(true);
    });

    it('waits for metadata and known duration, retries failed pause/seek and never plays media automatically', () => {
        const f = fixture(undefined, 'https://x.com/reader/status/123#fluentread-video=3000,5500'); const restore = createSavedVideoPositionRestorer();
        const play = vi.fn(); Object.assign(f.video, {readyState: 0, play});
        expect(restore.restore(f.video, f.location, f.document)).toBe(false);
        Object.assign(f.video, {readyState: 1});
        for (const duration of [NaN, Infinity, 0, -1, 3]) {Object.assign(f.video, {duration}); expect(restore.restore(f.video, f.location, f.document)).toBe(false);}
        Object.assign(f.video, {duration: 60});
        f.video.pause = vi.fn().mockImplementationOnce(() => {throw new Error('Not ready');});
        expect(restore.restore(f.video, f.location, f.document)).toBe(false);
        let seekable = false; let current = 0;
        Object.defineProperty(f.video, 'currentTime', {configurable: true, get: () => current, set(value) {if (!seekable) throw new Error('Seek blocked'); current = value;}});
        expect(restore.restore(f.video, f.location, f.document)).toBe(false);
        seekable = true; expect(restore.restore(f.video, f.location, f.document)).toBe(true); expect(current).toBe(3);
        expect(play).not.toHaveBeenCalled();
    });

    it('rejects malformed ranges, unsupported locations and ambiguous sources without touching the player', () => {
        const f = fixture(undefined, 'https://x.com/reader/status/123'); const restore = createSavedVideoPositionRestorer();
        for (const hash of ['', '#other', '#fluentread-video=-1,500', '#fluentread-video=1.5,500', '#fluentread-video=5,5',
            '#fluentread-video=500,400', '#fluentread-video=0,604800001', '#fluentread-video=9007199254740992,9007199254740993']) {
            f.location.hash = hash; expect(restore.restore(f.video, f.location, f.document)).toBe(false);
        }
        f.location.hash = '#fluentread-video=0,604800000'; expect(restore.restore(f.video, f.location, f.document)).toBe(true);
        const youtube = fixture(undefined, 'https://youtube.com/watch?v=dQw4w9WgXcQ#fluentread-video=3000,5500');
        expect(restore.restore(youtube.video, youtube.location, youtube.document)).toBe(false);
        const ambiguous = fixture('<article><a href="/reader/status/123">Original</a><a href="/quoted/status/999">Quote</a><video></video></article>', 'https://x.com/reader/status/123#fluentread-video=3000,5500');
        expect(restore.restore(ambiguous.video, ambiguous.location, ambiguous.document)).toBe(false); expect(ambiguous.video.pause).not.toHaveBeenCalled();
    });
});

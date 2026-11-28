import {describe, expect, it, vi} from 'vitest';
import {
    computeSeekKeepSources,
    createVideoCaptionClock,
    resolveVideoTranslationUiStatus,
} from '@/src/features/video-subtitle/content/captionClock';

describe('video captionClock helpers', () => {
    it('drives requestVideoFrameCallback when available and cancels cleanly on stop', () => {
        let scheduled: (() => void) | undefined;
        const cancelVfc = vi.fn();
        const onTick = vi.fn();
        const video = {
            paused: false,
            ended: false,
            isConnected: true,
            requestVideoFrameCallback: vi.fn((cb: () => void) => { scheduled = cb; return 42; }),
            cancelVideoFrameCallback: cancelVfc,
        } as unknown as HTMLVideoElement;

        let active = true;
        const clock = createVideoCaptionClock({
            getVideo: () => video,
            isActive: () => active,
            onTick,
        });

        clock.start();
        clock.start(); // idempotent while frame is pending
        expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);

        // Tick runs callback and reschedules
        scheduled?.();
        expect(onTick).toHaveBeenCalledWith(video);
        expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);

        // Stop cancels pending vfc handle
        clock.stop();
        expect(cancelVfc).toHaveBeenCalledWith(42);

        // Tick after inactive or disconnected skips onTick
        clock.start();
        active = false;
        scheduled?.();
        expect(onTick).toHaveBeenCalledTimes(1);
    });

    it('falls back to requestAnimationFrame for audio/older browsers and cancels cleanly', () => {
        const rafQueue: Array<() => void> = [];
        const cancelRaf = vi.fn();
        const origRaf = globalThis.requestAnimationFrame;
        const origCancel = globalThis.cancelAnimationFrame;
        vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => { rafQueue.push(cb); return 99; }));
        vi.stubGlobal('cancelAnimationFrame', cancelRaf);
        try {
            const onTick = vi.fn();
            const audio = {paused: false, ended: false, isConnected: true} as unknown as HTMLAudioElement;
            const clock = createVideoCaptionClock({
                getVideo: () => audio,
                isActive: () => true,
                onTick,
            });
            clock.start();
            expect(rafQueue).toHaveLength(1);
            rafQueue.shift()?.();
            expect(onTick).toHaveBeenCalledWith(audio);
            expect(rafQueue).toHaveLength(1);

            clock.stop();
            expect(cancelRaf).toHaveBeenCalledWith(99);

            // Stop tolerates missing cancelAnimationFrame
            clock.start();
            vi.stubGlobal('cancelAnimationFrame', undefined);
            clock.stop();
            vi.stubGlobal('cancelAnimationFrame', cancelRaf);

            // When paused or ended or null video, start does not schedule
            const beforePaused = rafQueue.length;
            (audio as {paused: boolean}).paused = true;
            clock.start();
            expect(rafQueue).toHaveLength(beforePaused);
        } finally {
            vi.stubGlobal('requestAnimationFrame', origRaf);
            vi.stubGlobal('cancelAnimationFrame', origCancel);
        }
    });

    it('no-ops cleanly when neither rVFC nor rAF is defined', () => {
        const origRaf = globalThis.requestAnimationFrame;
        vi.stubGlobal('requestAnimationFrame', undefined);
        try {
            const audio = {paused: false, ended: false, isConnected: true} as unknown as HTMLAudioElement;
            const clock = createVideoCaptionClock({
                getVideo: () => audio,
                isActive: () => true,
                onTick: vi.fn(),
            });
            clock.start();
            clock.stop();
        } finally {
            vi.stubGlobal('requestAnimationFrame', origRaf);
        }
    });

    it('computes seek keep sources with playbackRate clamped to >= 1 and guards non-finite time', () => {
        const cues = [
            {startMs: 0, durationMs: 2000, text: 'old'},
            {startMs: 5000, durationMs: 2000, text: 'current'},
            {startMs: 12000, durationMs: 2000, text: 'in-1x-window'},
            {startMs: 22000, durationMs: 2000, text: 'in-2x-window'},
            {startMs: 40000, durationMs: 2000, text: 'too-far'},
        ];
        expect(computeSeekKeepSources(cues, Number.NaN, 10_000, 1)).toEqual([]);
        expect(computeSeekKeepSources([], 5000, 10_000, 1)).toEqual([]);
        // At 0.5x playbackRate, rate clamps to 1 so [5s, 15s] stays kept
        expect(computeSeekKeepSources(cues, 5500, 10_000, 0.5)).toEqual(['current', 'in-1x-window']);
        // At 2x playbackRate, window scales to 20s -> [5.5s, 25.5s]
        expect(computeSeekKeepSources(cues, 5500, 10_000, 2)).toEqual(['current', 'in-1x-window', 'in-2x-window']);
    });

    it('resolves UI translation status lazily without calling hasActiveCueFailure unless retrying', () => {
        const probe = vi.fn(() => true);
        expect(resolveVideoTranslationUiStatus(false, {state: 'permanent', retryAt: Infinity, message: 'err'}, probe)).toEqual({status: 'idle'});
        expect(probe).not.toHaveBeenCalled();

        expect(resolveVideoTranslationUiStatus(true, {state: 'ok', retryAt: 0, message: ''}, probe)).toEqual({status: 'idle'});
        expect(probe).not.toHaveBeenCalled();

        expect(resolveVideoTranslationUiStatus(true, {state: 'permanent', retryAt: Infinity, message: 'Invalid key'}, probe)).toEqual({
            status: 'error',
            message: 'Invalid key',
            canRetry: true,
        });
        expect(resolveVideoTranslationUiStatus(true, {state: 'cooldown', retryAt: 5000, message: '429'}, probe)).toEqual({
            status: 'retrying',
            message: '429',
            canRetry: true,
        });
        expect(probe).not.toHaveBeenCalled();

        expect(resolveVideoTranslationUiStatus(true, {state: 'retrying', retryAt: 2000, message: 'Timeout'}, () => false)).toEqual({status: 'idle'});
        expect(resolveVideoTranslationUiStatus(true, {state: 'retrying', retryAt: 2000, message: 'Timeout'}, probe)).toEqual({
            status: 'error',
            message: 'Timeout',
            canRetry: true,
        });
        expect(probe).toHaveBeenCalledTimes(1);
    });
});

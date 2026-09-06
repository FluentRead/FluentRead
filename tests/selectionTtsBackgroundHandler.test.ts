import {describe, expect, it, vi} from 'vitest';

import {createBackgroundMessageRouter, type BackgroundMessageHandler} from '@/src/app/background/messageRouter';
import {
    createSelectionTtsBackgroundHandlers,
    googleSelectionTtsUrl,
    SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
    SELECTION_TTS_MESSAGE_TYPE,
    SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
    SELECTION_TTS_STOP_MESSAGE_TYPE,
    type SelectionTtsAudio,
    type SelectionTtsBackgroundDependencies,
    type SelectionTtsContext,
} from '@/src/features/selection-translation/background/ttsHandler';
import {createCapabilityGatedSelectionTtsTransport} from '@/src/app/background/capabilityRegistry';
import {resolveBrowserCapabilities} from '@/src/platform/browser/capabilities';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {promise, resolve, reject};
}

function audio(bytes = [1, 2, 3], voice = 'voice-a'): SelectionTtsAudio {
    return {
        audio: new Uint8Array(bytes).buffer,
        contentType: 'audio/mpeg',
        voice,
    };
}

function clientId(value: number | string): string {
    return `client-${value}`;
}

function createRouter(dependencies: SelectionTtsBackgroundDependencies) {
    const handlers = createSelectionTtsBackgroundHandlers(dependencies);
    return createBackgroundMessageRouter<SelectionTtsContext>(
        handlers as Array<BackgroundMessageHandler<SelectionTtsContext>>,
    );
}

function createSubject(overrides: Partial<SelectionTtsBackgroundDependencies> = {}) {
    const dependencies: SelectionTtsBackgroundDependencies = {
        getPreferredVoices: vi.fn(() => ['voice-a']),
        synthesize: vi.fn(async () => audio()),
        playWithOffscreen: vi.fn(async () => undefined),
        stopWithOffscreen: vi.fn(async () => undefined),
        sendTabMessage: vi.fn(async () => undefined),
        warn: vi.fn(),
        ...overrides,
    };
    const router = createRouter(dependencies);
    return {dependencies, router};
}

describe('selection TTS background handlers', () => {
    it('无 tab 的 Edge TTS 保留 page audio fallback，不进入 offscreen', async () => {
        const {dependencies, router} = createSubject();

        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: ' hello ',
            language: 'en',
            clientRequestId: clientId(7),
        }, {})).resolves.toEqual({
            handled: true,
            response: {
                success: true,
                audioBase64: 'AQID',
                contentType: 'audio/mpeg',
                voice: 'voice-a',
                transport: 'page',
            },
        });

        expect(dependencies.synthesize).toHaveBeenCalledWith('hello', 'en', ['voice-a'], undefined);
        expect(dependencies.playWithOffscreen).not.toHaveBeenCalled();
    });

    it('显式关闭扩展播放时直接返回 page audio，取消合成且不触碰文档或 warn', async () => {
        const synthesis = deferred<SelectionTtsAudio>();
        let signal: AbortSignal | undefined;
        const offscreen = {
            play: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
        };
        const transport = createCapabilityGatedSelectionTtsTransport(
            {...resolveBrowserCapabilities({browser: 'firefox', manifestVersion: 2}), selectionTtsExtensionPlayback: false},
            offscreen,
        );
        const {dependencies, router} = createSubject({
            offscreenPlaybackEnabled: false,
            playWithOffscreen: transport.play,
            stopWithOffscreen: transport.stop,
            synthesize: vi.fn((_text, _language, _voices, requestSignal) => {
                signal = requestSignal;
                return synthesis.promise;
            }),
        });

        const request = router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId('firefox'),
        }, {sender: {tab: {id: 17}}});
        await vi.waitFor(() => expect(dependencies.synthesize).toHaveBeenCalledOnce());
        await expect(router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId('firefox'),
        }, {sender: {tab: {id: 17}}})).resolves.toMatchObject({handled: true, response: {success: true}});
        expect(signal?.aborted).toBe(true);

        synthesis.resolve(audio());
        await expect(request).resolves.toEqual({
            handled: true,
            response: {success: false, error: '语音合成已取消'},
        });
        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello again',
            clientRequestId: clientId('firefox-page'),
        }, {sender: {tab: {id: 17}}})).resolves.toEqual({
            handled: true,
            response: {
                success: true,
                audioBase64: 'AQID',
                contentType: 'audio/mpeg',
                voice: 'voice-a',
                transport: 'page',
            },
        });
        await expect(router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello google',
            clientRequestId: clientId('firefox-google'),
        }, {sender: {tab: {id: 17}}})).resolves.toEqual({
            handled: true,
            response: {success: false, error: '当前浏览器暂不支持 Google TTS 扩展播放'},
        });
        expect(offscreen.play).not.toHaveBeenCalled();
        expect(offscreen.stop).not.toHaveBeenCalled();
        expect(dependencies.warn).not.toHaveBeenCalled();
    });

    it('tabId=0 与缺省语言保持可用', async () => {
        const {dependencies, router} = createSubject();

        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            language: '   ',
            clientRequestId: clientId('zero'),
        }, {sender: {tab: {id: 0}}})).resolves.toMatchObject({
            handled: true,
            response: {success: true, transport: 'offscreen'},
        });

        expect(dependencies.synthesize).toHaveBeenCalledWith('hello', 'en-US', ['voice-a'], expect.any(AbortSignal));
        expect(dependencies.playWithOffscreen).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 0,
            clientRequestId: clientId('zero'),
        }));
    });

    it('拒绝空文本和非法 clientRequestId，且不进入合成或停止副作用', async () => {
        const {dependencies, router} = createSubject();

        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: '   ',
        }, {sender: {tab: {id: 1}}})).rejects.toThrow('TTS 文本为空');
        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 123,
        }, {sender: {tab: {id: 1}}})).rejects.toThrow('TTS 文本为空');
        await expect(router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: 1.2,
        }, {sender: {tab: {id: 1}}})).rejects.toThrow('clientRequestId');
        await expect(router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: '',
        }, {sender: {tab: {id: 1}}})).rejects.toThrow('clientRequestId');

        expect(dependencies.synthesize).not.toHaveBeenCalled();
        expect(dependencies.stopWithOffscreen).not.toHaveBeenCalled();
    });

    it('Edge 合成失败时清理当前请求状态', async () => {
        const failure = new Error('synthesize failed');
        const {dependencies, router} = createSubject({
            synthesize: vi.fn(async () => { throw failure; }),
        });

        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId(8),
        }, {sender: {tab: {id: 2}}})).rejects.toBe(failure);
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId(8),
        }, {sender: {tab: {id: 2}}});

        expect(dependencies.stopWithOffscreen).toHaveBeenCalledWith({
            tabId: 2,
            clientRequestId: clientId(8),
        });
    });

    it('Edge offscreen 成功后由 playback state 转发给原始 client request', async () => {
        const {dependencies, router} = createSubject();

        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            language: undefined,
            clientRequestId: clientId(77),
        }, {sender: {tab: {id: 3}}})).resolves.toEqual({
            handled: true,
            response: {success: true, transport: 'offscreen', voice: 'voice-a'},
        });
        expect(dependencies.playWithOffscreen).toHaveBeenCalledWith({
            audioBase64: 'AQID',
            contentType: 'audio/mpeg',
            tabId: 3,
            clientRequestId: clientId(77),
        });

        await expect(router.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 3,
            clientRequestId: clientId(77),
            state: 'ended',
            error: 'done',
        }, {})).resolves.toEqual({handled: true, response: {success: true}});
        expect(dependencies.sendTabMessage).toHaveBeenCalledWith(3, {
            type: 'selectionTtsState',
            clientRequestId: clientId(77),
            state: 'ended',
            error: 'done',
        });

        await router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'again',
            clientRequestId: clientId(78),
        }, {sender: {tab: {id: 3}}});
        await router.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 3,
            clientRequestId: clientId(99),
            state: 'stale',
        }, {});
        expect(dependencies.sendTabMessage).toHaveBeenCalledTimes(1);
        await router.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 3,
            clientRequestId: clientId(78),
            state: 'error',
            error: 404,
        }, {});
        expect(dependencies.sendTabMessage).toHaveBeenLastCalledWith(3, {
            type: 'selectionTtsState',
            clientRequestId: clientId(78),
            state: 'error',
            error: undefined,
        });

        await router.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: '3',
            clientRequestId: clientId(77),
            state: 'late',
            error: 404,
        }, {});
        expect(dependencies.sendTabMessage).toHaveBeenCalledTimes(2);
    });

    it('MV3 handler factory 重建后仍按自描述路由转发 ended/error', async () => {
        const {dependencies, router: firstWorker} = createSubject();
        const clientRequestId = clientId('restart-ended');

        await firstWorker.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'survives worker restart',
            clientRequestId,
        }, {sender: {tab: {id: 31}}});

        // 模拟 MV3 Service Worker 被回收后重新执行 factory，新 handler 没有旧 active 内存。
        const restartedWorker = createRouter(dependencies);
        await restartedWorker.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 31,
            clientRequestId,
            state: 'ended',
        }, {});

        expect(dependencies.sendTabMessage).toHaveBeenCalledWith(31, {
            type: 'selectionTtsState',
            clientRequestId,
            state: 'ended',
            error: undefined,
        });

        await restartedWorker.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 31,
            clientRequestId: clientId('restart-error'),
            state: 'error',
            error: 'decode failed',
        }, {});
        expect(dependencies.sendTabMessage).toHaveBeenLastCalledWith(31, {
            type: 'selectionTtsState',
            clientRequestId: clientId('restart-error'),
            state: 'error',
            error: 'decode failed',
        });
    });

    it('MV3 handler factory 重建后 STOP 仍直达 offscreen 精确播放', async () => {
        const {dependencies, router: firstWorker} = createSubject();
        const clientRequestId = clientId('restart-stop');
        await firstWorker.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'stop after restart',
            clientRequestId,
        }, {sender: {tab: {id: 32}}});
        vi.mocked(dependencies.stopWithOffscreen).mockClear();

        const restartedWorker = createRouter(dependencies);
        await restartedWorker.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId,
        }, {sender: {tab: {id: 32}}});

        expect(dependencies.stopWithOffscreen).toHaveBeenCalledOnce();
        expect(dependencies.stopWithOffscreen).toHaveBeenCalledWith({tabId: 32, clientRequestId});
    });

    it('重建后旧 stopped 保留旧 UUID，不会冒充新播放状态', async () => {
        const {dependencies, router: firstWorker} = createSubject();
        const oldClientRequestId = clientId('old-before-restart');
        const newClientRequestId = clientId('new-after-restart');
        await firstWorker.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'old',
            clientRequestId: oldClientRequestId,
        }, {sender: {tab: {id: 33}}});

        const restartedWorker = createRouter(dependencies);
        await restartedWorker.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'new',
            clientRequestId: newClientRequestId,
        }, {sender: {tab: {id: 33}}});
        await restartedWorker.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 33,
            clientRequestId: oldClientRequestId,
            state: 'stopped',
        }, {});
        await restartedWorker.dispatch({
            type: SELECTION_TTS_PLAYBACK_STATE_MESSAGE_TYPE,
            tabId: 33,
            clientRequestId: newClientRequestId,
            state: 'ended',
        }, {});

        expect(dependencies.sendTabMessage).toHaveBeenNthCalledWith(1, 33, {
            type: 'selectionTtsState',
            clientRequestId: oldClientRequestId,
            state: 'stopped',
            error: undefined,
        });
        expect(dependencies.sendTabMessage).toHaveBeenNthCalledWith(2, 33, {
            type: 'selectionTtsState',
            clientRequestId: newClientRequestId,
            state: 'ended',
            error: undefined,
        });
    });

    it('STOP 匹配当前播放时 abort，并在 late PLAY 成功后二次 stop', async () => {
        const play = deferred<void>();
        const {dependencies, router} = createSubject({
            playWithOffscreen: vi.fn(() => play.promise),
        });

        const request = router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId(90),
        }, {sender: {tab: {id: 4}}});
        await vi.waitFor(() => expect(dependencies.playWithOffscreen).toHaveBeenCalled());
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId(90),
        }, {sender: {tab: {id: 4}}});
        play.resolve();

        await expect(request).resolves.toEqual({
            handled: true,
            response: {success: false, error: '语音播放已取消'},
        });
        expect(dependencies.stopWithOffscreen).toHaveBeenNthCalledWith(1, expect.objectContaining({
            tabId: 4,
            clientRequestId: clientId(90),
        }));
        expect(dependencies.stopWithOffscreen).toHaveBeenNthCalledWith(2, expect.objectContaining({
            tabId: 4,
            clientRequestId: clientId(90),
        }));
    });

    it('STOP 不匹配 clientRequestId 时不取消本地 active，仍路由精确 offscreen 目标', async () => {
        const {dependencies, router} = createSubject();

        await router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId(11),
        }, {sender: {tab: {id: 5}}});
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId(12),
        }, {sender: {tab: {id: 5}}});
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
        }, {});

        expect(dependencies.stopWithOffscreen).toHaveBeenCalledOnce();
        expect(dependencies.stopWithOffscreen).toHaveBeenCalledWith({tabId: 5, clientRequestId: clientId(12)});
    });

    it('新请求会取消仍在合成中的旧请求，旧请求不能覆盖新请求', async () => {
        const first = deferred<SelectionTtsAudio>();
        const {dependencies, router} = createSubject({
            synthesize: vi.fn()
                .mockReturnValueOnce(first.promise)
                .mockResolvedValueOnce(audio([4, 5, 6], 'voice-b')),
        });

        const oldRequest = router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'old',
            clientRequestId: clientId(1),
        }, {sender: {tab: {id: 6}}});
        await vi.waitFor(() => expect(dependencies.synthesize).toHaveBeenCalledTimes(1));
        const newRequest = router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'new',
            clientRequestId: clientId(2),
        }, {sender: {tab: {id: 6}}});
        await vi.waitFor(() => expect(dependencies.synthesize).toHaveBeenCalledTimes(2));
        first.resolve(audio());

        await expect(oldRequest).resolves.toEqual({
            handled: true,
            response: {success: false, error: '语音合成已取消'},
        });
        await expect(newRequest).resolves.toEqual({
            handled: true,
            response: {success: true, transport: 'offscreen', voice: 'voice-b'},
        });
        expect(dependencies.playWithOffscreen).toHaveBeenCalledTimes(1);
    });

    it('新请求会精确停止已开始的旧 offscreen 播放，停止失败不阻断新播放', async () => {
        const stopFailure = new Error('old offscreen already gone');
        const {dependencies, router} = createSubject({
            stopWithOffscreen: vi.fn(async () => { throw stopFailure; }),
        });
        await router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'old playing',
            clientRequestId: clientId('old-playing'),
        }, {sender: {tab: {id: 6}}});

        await expect(router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'new playing',
            clientRequestId: clientId('new-playing'),
        }, {sender: {tab: {id: 6}}})).resolves.toMatchObject({
            handled: true,
            response: {success: true, transport: 'offscreen'},
        });

        expect(dependencies.stopWithOffscreen).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 6,
            clientRequestId: clientId('old-playing'),
        }));
    });

    it('Edge offscreen 当前请求失败时回退 page audio，并记录 warn', async () => {
        const failure = new Error('offscreen unavailable');
        const {dependencies, router} = createSubject({
            playWithOffscreen: vi.fn(async () => { throw failure; }),
        });

        await expect(router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId('edge-fallback'),
        }, {sender: {tab: {id: 7}}})).resolves.toEqual({
            handled: true,
            response: {
                success: true,
                audioBase64: 'AQID',
                contentType: 'audio/mpeg',
                voice: 'voice-a',
                transport: 'page',
            },
        });

        expect(dependencies.warn).toHaveBeenCalledWith(
            'Offscreen TTS playback unavailable, returning page audio:',
            failure,
        );
    });

    it('Edge late PLAY 失败时按取消处理并二次 stop', async () => {
        const play = deferred<void>();
        const {dependencies, router} = createSubject({
            playWithOffscreen: vi.fn(() => play.promise),
        });

        const request = router.dispatch({
            type: SELECTION_TTS_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId(91),
        }, {sender: {tab: {id: 12}}});
        await vi.waitFor(() => expect(dependencies.playWithOffscreen).toHaveBeenCalled());
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId(91),
        }, {sender: {tab: {id: 12}}});
        play.reject(new Error('late edge failure'));

        await expect(request).resolves.toEqual({
            handled: true,
            response: {success: false, error: '语音播放已取消'},
        });
        expect(dependencies.stopWithOffscreen).toHaveBeenCalledTimes(2);
    });

    it('Google TTS 生成可播放 URL，offscreen 成功时返回 offscreen transport', async () => {
        const {dependencies, router} = createSubject();

        await expect(router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: ' hello world ',
            language: 'zh-Hans',
            clientRequestId: clientId(9),
        }, {sender: {tab: {id: 8}}})).resolves.toEqual({
            handled: true,
            response: {success: true, transport: 'offscreen'},
        });

        expect(dependencies.playWithOffscreen).toHaveBeenCalledWith({
            sourceUrl: googleSelectionTtsUrl('hello world', 'zh-Hans'),
            tabId: 8,
            clientRequestId: clientId(9),
        });
    });

    it('Google TTS 无 tab 返回错误，并且失败时返回 offscreen 错误', async () => {
        const {router} = createSubject();
        await expect(router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId('no-tab'),
        }, {})).resolves.toEqual({
            handled: true,
            response: {success: false, error: '无法确定当前标签页'},
        });

        const {router: failingRouter} = createSubject({
            playWithOffscreen: vi.fn(async () => { throw 'google play failed'; }),
        });
        await expect(failingRouter.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId('failure'),
        }, {sender: {tab: {id: 9}}})).resolves.toEqual({
            handled: true,
            response: {success: false, error: 'google play failed'},
        });

        const {router: errorRouter} = createSubject({
            playWithOffscreen: vi.fn(async () => { throw new Error('google error object'); }),
        });
        await expect(errorRouter.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId('error'),
        }, {sender: {tab: {id: 9}}})).resolves.toEqual({
            handled: true,
            response: {success: false, error: 'google error object'},
        });
    });

    it('Google late PLAY 使用二次 stop 并返回取消', async () => {
        const play = deferred<void>();
        const {dependencies, router} = createSubject({
            playWithOffscreen: vi.fn(() => play.promise),
        });

        const request = router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId(20),
        }, {sender: {tab: {id: 10}}});
        await vi.waitFor(() => expect(dependencies.playWithOffscreen).toHaveBeenCalled());
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId(20),
        }, {sender: {tab: {id: 10}}});
        play.resolve();

        await expect(request).resolves.toEqual({
            handled: true,
            response: {success: false, error: '语音播放已取消'},
        });
        expect(dependencies.stopWithOffscreen).toHaveBeenCalledTimes(2);
    });

    it('Google late PLAY 失败时仍按取消处理并二次 stop', async () => {
        const play = deferred<void>();
        const {dependencies, router} = createSubject({
            playWithOffscreen: vi.fn(() => play.promise),
        });

        const request = router.dispatch({
            type: SELECTION_TTS_GOOGLE_MESSAGE_TYPE,
            text: 'hello',
            clientRequestId: clientId(21),
        }, {sender: {tab: {id: 11}}});
        await vi.waitFor(() => expect(dependencies.playWithOffscreen).toHaveBeenCalled());
        await router.dispatch({
            type: SELECTION_TTS_STOP_MESSAGE_TYPE,
            clientRequestId: clientId(21),
        }, {sender: {tab: {id: 11}}});
        play.reject('late failure');

        await expect(request).resolves.toEqual({
            handled: true,
            response: {success: false, error: '语音播放已取消'},
        });
        expect(dependencies.stopWithOffscreen).toHaveBeenCalledTimes(2);
    });
});

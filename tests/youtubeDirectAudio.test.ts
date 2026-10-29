import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {discoverYoutubeDirectAudio, isYoutubeDirectAudioUrl, selectYoutubeDirectAudio, youtubeAudioVideoId} from '@/src/features/video-subtitle/content/youtubeAudio';
import {readYoutubeDirectAudio, YOUTUBE_AUDIO_READ_ERROR, YOUTUBE_AUDIO_CLOSE_WARNING} from '@/src/features/video-subtitle/content/youtubeAudioReader';
import * as transcription from '@/src/features/video-subtitle/transcription';
import {YoutubeAiCaptionSource, isYoutubeAdvertisement} from '@/src/features/video-subtitle/content/youtubeAiCaptionSource';

const id = 'abcdefghijk', url = 'https://rr1.example.googlevideo.com/videoplayback?fake=test';
const format = () => ({url, mimeType: 'audio/mp4; codecs="mp4a.40.2"', contentLength: '4', approxDurationMs: '1000'});
const response = () => ({videoDetails: {videoId: id, lengthSeconds: '1', isLiveContent: false}, playabilityStatus: {status: 'OK'}, streamingData: {adaptiveFormats: [format()]}});
const track = () => selectYoutubeDirectAudio(response(), id)!;
afterEach(() => {vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();});

describe('YouTube direct audio eligibility (synthetic metadata, not live acceptance)', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abcdefghijk', id], ['https://youtube.com/shorts/abcdefghijk', id],
    ['https://m.youtube.com/embed/abcdefghijk/', id], ['https://youtube.com/watch?v=bad', ''],
    ['https://youtube.com/watch', ''], ['https://youtube.com/', ''], ['https://youtube.com.evil/watch?v=abcdefghijk', ''],
  ])('binds supported page identity %s', (href, expected) => expect(youtubeAudioVideoId(new URL(href))).toBe(expected));
  it.each([null, 1, '', 'x', 'https://googlevideo.com.evil/videoplayback', 'https://evilgooglevideo.com/videoplayback',
    'http://googlevideo.com/videoplayback', 'https://u:p@googlevideo.com/videoplayback', 'https://@googlevideo.com/videoplayback', 'https://:@googlevideo.com/videoplayback', 'https:\n//@googlevideo.com/videoplayback', 'https://googlevideo.com:444/videoplayback',
    'https://googlevideo.com/videoplayback#hash', 'https://googlevideo.com/other', url + '&range=1-2', url + '&sq=1', url + '&rn=1',
    url + '&source=yt_live_broadcast', 'a'.repeat(16385)])('rejects unsafe or partial URL %#', value => expect(isYoutubeDirectAudioUrl(value)).toBe(false));
  it('accepts root host and picks smallest fully qualified audio without mutating URLs', () => {
    expect(isYoutubeDirectAudioUrl('https://googlevideo.com/videoplayback')).toBe(true);
    const data = {...response(), streamingData: {adaptiveFormats: [
      {...format(), audioTrack: {id: 'en.1', audioIsDefault: true}}, {...format(), contentLength: '3', audioTrack: {id: 'en.1', audioIsDefault: true}},
    ]}};
    expect(selectYoutubeDirectAudio(data, id)).toEqual({...track(), bytes: 3});
    expect(selectYoutubeDirectAudio({...data, streamingData: {adaptiveFormats: [{...format(), mimeType: 'audio/webm; codecs="opus"'}]}}, id)?.mime).toBe('audio/webm');
  });
  it.each([null, [], 3, {}, {videoDetails: null}, {videoDetails: {videoId: id}},
    {...response(), playabilityStatus: {}}, {...response(), streamingData: {}},
    ...[undefined, true].map(isLiveContent => ({...response(), videoDetails: {...response().videoDetails, isLiveContent}})),
    {...response(), videoDetails: {...response().videoDetails, isLive: true}},
    ...[0, -1, ' ', 'no', Infinity, '1201'].map(lengthSeconds => ({...response(), videoDetails: {...response().videoDetails, lengthSeconds}})),
  ])('rejects unknown/live/incomplete response %#', value => expect(selectYoutubeDirectAudio(value, id)).toBeNull());
  it('rejects mismatched or malformed identity', () => {
    expect(selectYoutubeDirectAudio(response(), 'XXXXXXXXXXX')).toBeNull();expect(selectYoutubeDirectAudio(response(), '')).toBeNull();
  });
  it.each([null, [], 1, {url: 'bad'}, {mimeType: ''}, {mimeType: 1}, {mimeType: 'video/mp4; codecs="mp4a.40.2"'}, {mimeType: 'audio/ogg'},
    {signatureCipher: ''}, {cipher: ''}, {type: 'FORMAT_STREAM_TYPE_OTF'}, {targetDurationSec: 1},
    ...[0, -1, 1.5, NaN, Infinity, '33554433', 'bad', null].map(contentLength => ({contentLength})),
    ...[0, -1, Infinity, '1201000', '3000', null].map(approxDurationMs => ({approxDurationMs})),
  ])('rejects unsupported format %#', value => {
    const data = {...response(), streamingData: {adaptiveFormats: [value && typeof value === 'object' && !Array.isArray(value) ? {...format(), ...value} : value]}};
    expect(selectYoutubeDirectAudio(data, id)).toBeNull();
  });
  it('selects the explicit default instead of a smaller dubbed track; cipher variants still participate in identity checks', () => {
    const data = {...response(), streamingData: {adaptiveFormats: [
      {...format(), audioTrack: {id: 'en.1', audioIsDefault: true}},
      {...format(), contentLength: '1', audioTrack: {id: 'fr.2', audioIsDefault: false}},
    ]}};
    expect(selectYoutubeDirectAudio(data, id)?.bytes).toBe(4);
    data.streamingData.adaptiveFormats[0] = {...data.streamingData.adaptiveFormats[0], url: ''};
    expect(selectYoutubeDirectAudio(data, id)).toBeNull();
  });
  it('accepts a single identified track across multiple encodings without guessing another track', () => {
    const data = {...response(), streamingData: {adaptiveFormats: [
      {...format(), audioTrack: {id: 'en.1'}}, {...format(), contentLength: '3', audioTrack: {id: 'en.1'}},
    ]}};
    expect(selectYoutubeDirectAudio(data, id)?.bytes).toBe(3);
  });
  it.each([
    [undefined, undefined], [undefined, {id: 'en', audioIsDefault: true}], [{id: 'en'}, {id: 'fr'}],
    [{id: 'en', audioIsDefault: true}, {id: 'fr', audioIsDefault: true}],
    [{id: 'en', audioIsDefault: true}, {id: 'en', audioIsDefault: false}],
    [{id: 'en', audioIsDefault: false}], [null], [{}], [{id: 1}], [{id: ''}], [{id: 'en', audioIsDefault: 'true'}],
  ])('rejects nondefault or ambiguous audio-track metadata %#', (...tracks) => {
    expect(selectYoutubeDirectAudio({...response(), streamingData: {adaptiveFormats: tracks.map(audioTrack => ({...format(), audioTrack}))}}, id)).toBeNull();
  });
  it('scans bounded JSON without executing script and ignores stale, malformed and unsupported entries', () => {
    const {document} = parseHTML('<html><head></head></html>');
    const add = (text: string) => {const script = document.createElement('script');script.textContent = text;document.head.append(script);};
    add('');add('unrelated');add('ytInitialPlayerResponse = nope');add('ytInitialPlayerResponse = {');
    add('ytInitialPlayerResponse = {broken}');add('ytInitialPlayerResponse = ' + JSON.stringify(response()).replace(id, 'XXXXXXXXXXX'));
    add('ytInitialPlayerResponse ' + 'x'.repeat(2000001));
    expect(discoverYoutubeDirectAudio(document, id)).toBeNull();
    add('var ytInitialPlayerResponse = ' + JSON.stringify({...response(), test: '\\"}'} ) + '; throw new Error("not executed")');
    expect(discoverYoutubeDirectAudio(document, id)).toEqual(track());
  });
});

function audioFixture() {
  const decoded = {duration: 1, numberOfChannels: 1, sampleRate: 16000, getChannelData: vi.fn(() => new Float32Array(16000).fill(.05))};
  const close = vi.fn(async () => {}), decode = vi.fn(async () => decoded);
  const context = {state: 'running', close, decodeAudioData: decode};
  const construct = vi.fn(function () {return context;});vi.stubGlobal('AudioContext', construct);
  const fetcher = vi.fn(async () => new Response(new Uint8Array(4), {headers: {'content-type': 'audio/mp4', 'content-length': '4'}}));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController(), current = vi.fn(() => true);
  return {decoded, close, decode, context, construct, fetcher, controller, current,
    read: () => readYoutubeDirectAudio(track(), controller.signal, current)};
}

describe('YouTube isolated reader', () => {
  it('reads only audio and closes context; no URL is forwarded anywhere else', async () => {
    const f = audioFixture();expect(await f.read()).toHaveLength(16000);expect(f.close).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledWith(url, expect.objectContaining({credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store'}));
  });
  it.each([{url: 'bad'}, {bytes: 0}, {bytes: 33554433}, {bytes: 1.5}, {duration: 0}, {duration: Infinity}, {duration: 1201}])('rejects invalid track before network %#', async patch => {
    const f = audioFixture();await expect(readYoutubeDirectAudio({...track(), ...patch}, f.controller.signal, f.current)).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['abort', 'identity'])('rejects before network for %s', async kind => {
    const f = audioFixture();if (kind === 'abort') f.controller.abort();else f.current.mockReturnValue(false);
    await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['status', 'redirect', 'range', 'mime', 'missing-mime', 'length', 'short', 'oversize', 'empty-body'])('rejects %s response and never decodes', async kind => {
    const f = audioFixture();const headers: Record<string, string> = {'content-type': 'audio/mp4', 'content-length': '4'};
    if (kind === 'range') headers['content-range'] = 'bytes 0-3/4';
    if (kind === 'mime') headers['content-type'] = 'video/mp4';if (kind === 'missing-mime') delete headers['content-type'];
    if (kind === 'length') headers['content-length'] = '5';
    const result = new Response(kind === 'empty-body' ? null : new Uint8Array(kind === 'short' ? 3 : kind === 'oversize' ? 5 : 4), {headers, status: kind === 'status' ? 206 : 200});
    if (kind === 'redirect') Object.defineProperty(result, 'redirected', {value: true});
    f.fetcher.mockResolvedValue(result);await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);expect(f.decode).not.toHaveBeenCalled();
  });
  it.each([{duration: 2}, {duration: NaN}, {numberOfChannels: 0}, {numberOfChannels: 3}, {sampleRate: NaN}, {sampleRate: 1}, {sampleRate: 192001}])('rejects malformed decoded audio %#', async patch => {
    const f = audioFixture();Object.assign(f.decoded, patch);await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([new Float32Array(0), new Float32Array(1), new Float32Array(16000).fill(NaN), new Float32Array(16000).fill(1.1)])('rejects invalid PCM %#', async channel => {
    const f = audioFixture();f.decoded.getChannelData.mockReturnValue(channel);await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);
  });
  it('rejects corrupted resampler output rather than accepting partial PCM', async () => {
    const f = audioFixture();vi.spyOn(transcription, 'resampleToWhisperAudio').mockReturnValue(new Float32Array(1));
    await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);
  });
  it('resamples stereo and accepts exact content type parameters', async () => {
    const f = audioFixture();f.decoded.numberOfChannels = 2;f.decoded.sampleRate = 48000;
    f.decoded.getChannelData.mockReturnValue(new Float32Array(48000));expect(await f.read()).toHaveLength(16000);
  });
  it('sanitizes decode/fetch errors including signed URLs and tolerates closed context', async () => {
    const f = audioFixture();f.fetcher.mockRejectedValueOnce(new Error(url));await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);
    f.decode.mockRejectedValueOnce(new Error(url));f.context.state = 'closed';await expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);expect(f.close).not.toHaveBeenCalled();
  });
  it.each(['reject', 'throw'])('reports one URL-free cleanup warning on %s without rejecting successful PCM', async kind => {
    const warning = vi.spyOn(console, 'warn'), f = audioFixture();
    if (kind === 'reject') f.close.mockRejectedValue(new Error(url));else f.close.mockImplementation(() => {throw new Error(url);});
    expect(await f.read()).toHaveLength(16000);
    expect(warning).toHaveBeenCalledOnce();expect(warning).toHaveBeenCalledWith(YOUTUBE_AUDIO_CLOSE_WARNING);expect(JSON.stringify(warning.mock.calls)).not.toContain(url);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('does not wait for a pending close handshake', async () => {
    const f = audioFixture();f.close.mockImplementation(() => new Promise(() => {}));
    expect(await f.read()).toHaveLength(16000);expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(['abort', 'timeout', 'navigate'])('cancels pending decode on %s and discards late PCM', async reason => {
    vi.useFakeTimers();const f = audioFixture();let resolve!: (value: typeof f.decoded) => void;
    f.decode.mockImplementation(() => new Promise(done => {resolve = done;}));
    const pending = f.read();const rejected = expect(pending).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);await vi.advanceTimersByTimeAsync(0);
    if (reason === 'abort') f.controller.abort();else if (reason === 'timeout') await vi.advanceTimersByTimeAsync(30000);else f.current.mockReturnValue(false);
    resolve(f.decoded);await rejected;expect(f.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels the body of a late response after navigation without decoding it', async () => {
    const f = audioFixture();let resolve!: (value: Response) => void;
    f.fetcher.mockImplementation(() => new Promise(done => {resolve = done;}));
    const pending = f.read();const rejected = expect(pending).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);
    f.current.mockReturnValue(false);const cancel = vi.fn();
    resolve(new Response(new ReadableStream({cancel}), {headers: {'content-type': 'audio/mp4', 'content-length': '4'}}));
    await rejected;expect(cancel).toHaveBeenCalledOnce();expect(f.construct).not.toHaveBeenCalled();
  });
  it('timeout bounds even a fetch implementation that ignores cancellation', async () => {
    vi.useFakeTimers();const f = audioFixture();f.fetcher.mockImplementation(() => new Promise(() => {}));
    const pending = expect(f.read()).rejects.toThrow(YOUTUBE_AUDIO_READ_ERROR);await vi.advanceTimersByTimeAsync(30000);await pending;expect(f.construct).not.toHaveBeenCalled();
  });
});

describe('YouTube AI source ownership', () => {
  it('isolates ads, identity, native CC and player mutations, with cue gaps and teardown', () => {
    const {document} = parseHTML('<div id="one"><video></video><button aria-pressed="true"></button></div><div id="two"></div>');
    const owner = new YoutubeAiCaptionSource(), player = document.getElementById('one')!;
    const video = player.querySelector('video')! as HTMLVideoElement;video.currentTime = 1;
    const state = {video, player, enabled: true, active: true, videoId: id, generationVideoId: id, cues: [{startMs: 0, durationMs: 2000, text: 'local cue'}]};
    expect(isYoutubeAdvertisement(null)).toBe(false);expect(isYoutubeAdvertisement(undefined)).toBe(false);
    const container = owner.sync(state)!;expect(container.firstElementChild?.textContent).toBe('local cue');expect(owner.sync(state)).toBe(container);
    video.currentTime = 3;expect(owner.sync(state)?.firstElementChild?.textContent).toBe('');
    owner.sync({...state, player: document.getElementById('two')!});expect(player.classList.contains('fluent-read-youtube-ai-source')).toBe(false);
    for (const patch of [{video: null}, {player: null}, {enabled: false}, {active: false}, {videoId: ''}, {generationVideoId: 'other'}, {cues: []}]) {
      expect(owner.sync({...state, ...patch})).toBeNull();owner.sync(state);
    }
    player.classList.add('ad-showing');expect(owner.sync(state)).toBeNull();player.classList.remove('ad-showing');
    player.classList.add('ad-interrupting');expect(isYoutubeAdvertisement(player)).toBe(true);player.classList.remove('ad-interrupting');
    owner.sync(state);owner.clear();owner.clear();expect(document.getElementById('fluent-read-video-ai-caption-container')).toBeNull();
    expect(player.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');expect(video.currentTime).toBe(3);
  });
});

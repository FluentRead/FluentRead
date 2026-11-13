/**
 * @file tests/videoCourseCaptions.test.ts
 * 文件职责：验证课程字幕来源、账号域边界、原文优先和切换后的异步所有权。
 * 主要内容：以实际响应流验证三个平台的时间轴，覆盖非法元数据、语言切换、分 P、取消、失败重试与只读桥消息。
 * 模块边界：只替换网络与页面端口，不连接账号或在线翻译服务。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {normalizeVideoCourseAutoStart} from '@/src/core/config/videoCourse';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {captionRecord, chooseBilibiliCaption, chooseUdemyCaption, getBilibiliPart, getCourseCaptionRequest, parseCourseCaptionJson, resolveCourseCaptionUrl, type CourseCaptionRequest} from '@/src/features/video-subtitle/content/courseCaptionData';
import {CourseCaptionSource} from '@/src/features/video-subtitle/content/courseCaptionSource';
import {installBilibiliCaptionBridge, requestBilibiliCaptionManifest} from '@/src/features/video-subtitle/content/bilibiliCaptionBridge';
import {startBilibiliCaptionBridgeApp} from '@/src/app/content/bilibiliCaptionBridge';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const bili = new URL('https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
const udemy = new URL('https://company.udemy.com/course/programming/learn/lecture/123/');
const edx = new URL('https://courses.edx.org/courses/courseware/unit');
const video = () => parseHTML('<video></video>').document.querySelector('video') as unknown as HTMLVideoElement;
const cue = {startMs: 0, durationMs: 1000, text: 'Original sentence.'};
const biliBody = {body: [{from: 0, to: 1, content: cue.text}]};
const transcript = {start: [0], end: [1000], text: [cue.text]};
const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nOriginal sentence.\n';
const json = (value: unknown) => new Response(JSON.stringify(value));
const caption = (language = 'en_US', source = 'manual') => ({locale_id: language, source, status: 1, url: 'https://captions.udemycdn.com/original.vtt'});
const biliTrack = (lan = 'en') => ({lan, subtitle_url: '//aisubtitle.hdslb.com/source.json'});

describe('课程字幕配置与身份', () => {
    it('新站点默认关闭，Udemy 保留已有行为；旧配置和非法字段不串站点', () => {
        for (const value of [undefined, null, false, {}, []]) expect(normalizeVideoCourseAutoStart(value)).toEqual({bilibili: false, udemy: true, edx: false});
        expect(normalizeVideoCourseAutoStart({bilibili: true, udemy: false, edx: true, unknown: true})).toEqual({bilibili: true, udemy: false, edx: true});
        expect(normalizeVideoCourseAutoStart({bilibili: 'true', udemy: 0, edx: 1})).toEqual(new Config().videoCourseAutoStart);
        expect(normalizeConfig({videoCourseAutoStart: {edx: true}}).videoCourseAutoStart).toEqual({bilibili: false, udemy: true, edx: true});
        expect(captionRecord(null)).toEqual({}); expect(captionRecord([])).toEqual({}); expect(captionRecord(1)).toEqual({});
    });
    it.each([
        ['/video/BV1xx411c7mD/?p=2', 'BV1xx411c7mD:2'], ['/zh-Hans/video/av123?p=3', 'av123:3'],
        ['/list/123?bvid=BV1xx411c7mD&p=0', 'BV1xx411c7mD:1'], ['/video/av123?p=1.1', 'av123:1'],
        ['/video/av123?p=9007199254740992', 'av123:1'], ['/list/123', ''], ['/video/invalid', ''], ['/bangumi/play/ep123', ''],
    ])('分 P 地址 %s', (path, expected) => expect(getBilibiliPart(new URL(path, bili))).toBe(expected));
    it('只为课程视频生成请求，小节和语言变化产生不同身份', () => {
        expect(getCourseCaptionRequest('bilibili', bili, video())?.key).toBe('BV1xx411c7mD:2');
        expect(getCourseCaptionRequest('bilibili', new URL('/bangumi/play/ep1', bili), video())).toBeNull();
        expect(getCourseCaptionRequest('udemy', udemy, video())?.key).toBe('programming/123');
        expect(getCourseCaptionRequest('udemy', new URL('/course/demo/learn/', udemy), video())).toBeNull();
        expect(getCourseCaptionRequest('edx', edx, video())).toBeNull();
        const {document} = parseHTML('<div class="video" data-block-id="block-1"><video></video><div class="langs-list"><button class="is-active" data-lang-code="es"></button></div></div>');
        const block = document.querySelector<HTMLElement>('.video')!, element = document.querySelector('video') as unknown as HTMLVideoElement;
        block.dataset.metadata = JSON.stringify({transcriptLanguage: 'en', transcriptTranslationUrl: '/transcript/__lang__'});
        const selected = getCourseCaptionRequest('edx', edx, element)!;
        expect(selected.language).toBe('es'); expect(selected.url).toBe('https://courses.edx.org/transcript/es');
        document.querySelector('button')!.remove();
        expect(getCourseCaptionRequest('edx', edx, element)!.key).not.toBe(selected.key);
        block.removeAttribute('data-block-id'); block.id = 'fallback'; expect(getCourseCaptionRequest('edx', edx, element)?.id).toBe('fallback');
        block.id = ''; expect(getCourseCaptionRequest('edx', edx, element)).toBeNull();
        block.id = 'block';
        for (const metadata of ['broken', '{}', JSON.stringify({transcriptLanguage: 'bad?x', transcriptTranslationUrl: '/transcript/__lang__'}),
            JSON.stringify({transcriptLanguage: 'en', transcriptTranslationUrl: 'https://evil.test/subtitles'})]) {
            block.dataset.metadata = metadata; expect(getCourseCaptionRequest('edx', edx, element)).toBeNull();
        }
        block.removeAttribute('data-metadata'); expect(getCourseCaptionRequest('edx', edx, element)).toBeNull();
    });
});

describe('原文轨道和有界时间轴', () => {
    it.each([null, 1, '', 'x'.repeat(8193), 'https://', 'http://aisubtitle.hdslb.com/x', 'https://u:p@aisubtitle.hdslb.com/x', 'https://evil.test/x', 'https://hdslb.com.evil.test/x'])('拒绝 B 站不可信资源 %s', value => {
        expect(resolveCourseCaptionUrl(value, bili, 'bilibili')).toBe('');
    });
    it('选择人工 B 站轨，AI 仅回退；原文轨不受目标语言影响', () => {
        expect(chooseBilibiliCaption(null, bili)).toBeNull(); expect(chooseBilibiliCaption([], bili)).toBeNull();
        const ai = biliTrack('ai-en'), human = biliTrack('en');
        expect(chooseBilibiliCaption([null, {}, {...human, lan: 1}, {...human, lan: ''}, ai, human], bili)).toEqual({url: 'https://aisubtitle.hdslb.com/source.json', language: 'en', manual: true});
        expect(chooseBilibiliCaption([ai], bili)?.manual).toBe(false);
        expect(resolveCourseCaptionUrl('/subtitles', udemy, 'udemy')).toBe('https://company.udemy.com/subtitles');
        expect(resolveCourseCaptionUrl('https://udemycdn.com.evil.test/x', udemy, 'udemy')).toBe('');
    });
    it('Udemy 原始语言优先，再选择人工；不把另一种语言的机译轨当原文', () => {
        expect(chooseUdemyCaption({}, 'en', udemy)).toBeNull();
        expect(chooseUdemyCaption([caption('zh_CN'), caption('en_US', 'auto'), caption()], 'en_GB', udemy)?.manual).toBe(true);
        expect(chooseUdemyCaption([caption('zh_CN')], 'en', udemy)).toBeNull();
        expect(chooseUdemyCaption([caption('en_US', 'auto')], 'en', udemy)?.manual).toBe(false);
        const variants = [{...caption(), locale_id: undefined, locale: 'en_US'}, {...caption(), locale_id: undefined, locale: {locale: 'en_US'}}];
        for (const value of variants) expect(chooseUdemyCaption([value], 'en', udemy)?.language).toBe('en-US');
        expect(chooseUdemyCaption([caption()], '', udemy)?.language).toBe('en-US');
        expect(chooseUdemyCaption([null, {...caption(), status: 0}, {...caption(), url: 'https://evil.test/x'}, {...caption(), locale_id: 1}, {...caption(), locale_id: '', locale: ''}], 'en', udemy)).toBeNull();
    });
    it('时间戳精确，空档和坏数据不会补成字幕；edX 缺失截止时才用下句和末句三秒', () => {
        expect(parseCourseCaptionJson('bilibili', biliBody)).toEqual([cue]);
        expect(parseCourseCaptionJson('bilibili', {body: [null, {}, {from: '0', to: 1, content: 'bad'},
            {from: 1, to: 2, content: 1}, {from: 1, content: 'bad'}, {from: -1, to: 1, content: 'bad'}, {from: 0, to: Infinity, content: 'bad'},
            {from: 2, to: 1, content: 'bad'}, {from: NaN, to: 1, content: 'bad'}]})).toEqual([]);
        expect(parseCourseCaptionJson('bilibili', {})).toEqual([]);
        expect(parseCourseCaptionJson('bilibili', {body: new Array(200001)})).toEqual([]);
        expect(parseCourseCaptionJson('edx', transcript)).toEqual([cue]);
        expect(parseCourseCaptionJson('edx', {start: [0, 1000], text: ['First.', 'Last.']})).toEqual([
            {startMs: 0, durationMs: 1000, text: 'First.'}, {startMs: 1000, durationMs: 3000, text: 'Last.'},
        ]);
        for (const value of [{}, {start: [], text: 1}, {start: [0], text: []}, {start: [], text: [], end: 1},
            {start: [0], text: ['x'], end: []}, {start: ['x'], text: ['x']}, {start: [0], end: ['x'], text: ['x']},
            {start: [0], end: [1000], text: [1]}, {start: new Array(200001), text: new Array(200001)}]) {
            expect(parseCourseCaptionJson('edx', value)).toEqual([]);
        }
    });
});

function sourceFixture(base = edx, bodies: unknown[] = [transcript]) {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        const next = bodies.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'string' ? new Response(next) : json(next);
    });
    const manifest = vi.fn(async () => 456), changed = vi.fn(), resources = vi.fn(() => [] as string[]);
    const source = new CourseCaptionSource({base, fetch, manifest, changed, resources});
    const request: CourseCaptionRequest = base === bili ? {platform: 'bilibili', key: 'BV1xx411c7mD:2', id: 'BV1xx411c7mD:2', language: '', url: ''}
        : base === udemy ? {platform: 'udemy', key: 'programming/123', id: 'programming/123', language: '', url: ''}
        : {platform: 'edx', key: 'block:en', id: 'block', language: 'en', url: new URL('/transcript/en', base).href};
    return {source, fetch, manifest, changed, resources, request};
}
async function settled(source: CourseCaptionSource) { await vi.waitFor(() => expect(source.status).not.toBe('loading')); }

describe('课程字幕请求生命周期', () => {
    it('同一身份只读取一次，关闭后清空；失败需明确重试', async () => {
        const f = sourceFixture(edx, [new Error('offline'), transcript]);
        f.source.sync(null, 'media'); expect(f.fetch).not.toHaveBeenCalled();
        f.source.sync(f.request, 'media'); f.source.sync(f.request, 'media'); await settled(f.source);
        expect(f.source.status).toBe('error'); expect(f.fetch).toHaveBeenCalledOnce(); expect(f.changed).toHaveBeenCalledOnce();
        f.source.sync(f.request, 'media'); expect(f.fetch).toHaveBeenCalledOnce();
        f.source.retry(); f.source.sync(f.request, 'media'); await settled(f.source);
        expect(f.source.cues).toEqual([cue]); expect(f.source.language).toBe('en');
        expect(f.fetch.mock.calls[1][0]).toBe('https://courses.edx.org/transcript/en');
        f.source.sync(null, ''); expect(f.source.status).toBe('idle'); expect(f.source.cues).toEqual([]);
    });
    it('换视频或语言时取消并拒绝旧响应；旧失败不改变新状态', async () => {
        let complete!: (value: Response) => void;
        const f = sourceFixture();
        f.fetch.mockImplementationOnce(() => new Promise(resolve => {complete = resolve;}));
        f.source.sync(f.request, 'old');
        const signal = (f.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
        f.source.sync({...f.request, key: 'block:es', language: 'es'}, 'new');
        expect(signal.aborted).toBe(true);
        await settled(f.source); complete(json({start: [0], text: ['Stale']}));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(f.source.cues).toEqual([cue]); expect(f.source.language).toBe('es'); expect(f.changed).toHaveBeenCalledOnce();
        f.source.clear();
    });
    it('正文读取结束和时间轴发布之间关闭，不提交迟到字幕或通知', async () => {
        const f = sourceFixture();
        f.fetch.mockImplementationOnce(async (_input, init) => {
            init!.signal!.addEventListener('abort', () => f.source.clear(), {once: true});
            return json(transcript);
        });
        f.source.sync(f.request, 'media');
        await vi.waitFor(() => expect(f.source.status).toBe('idle'));
        expect(f.source.cues).toEqual([]); expect(f.changed).not.toHaveBeenCalled();
    });
    it('B 站优先当前 CID 签名资源，限制域名，元数据错配拒绝提交', async () => {
        const f = sourceFixture(bili, [{data: {cid: 456, subtitle: {subtitles: [biliTrack('ai-en'), biliTrack()]}}}, biliBody]);
        f.resources.mockReturnValue(['https://api.bilibili.com/x/player/v2?cid=456&w_rid=signed', 'bad',
            'https://evil.test/x/player/v2?cid=456', 'https://api.bilibili.com/x/player/wbi/v2?cid=999']);
        f.source.sync(f.request, 'media'); await settled(f.source);
        expect(f.fetch.mock.calls[0][0]).toContain('w_rid=signed'); expect(f.source.cues).toEqual([cue]);
        expect(f.manifest).toHaveBeenCalledWith('BV1xx411c7mD:2', expect.any(AbortSignal));
        f.source.clear();
        const mismatch = sourceFixture(bili, [{data: {cid: 999}}]); mismatch.source.sync(mismatch.request, 'media'); await settled(mismatch.source);
        expect(mismatch.source.status).toBe('error');
    });
    it('B 站无签名资源回退固定接口，没有字幕时保持空状态', async () => {
        const f = sourceFixture(bili, [{data: {cid: 456, subtitle: {subtitles: []}}}]);
        f.source.sync(f.request, 'media'); await settled(f.source);
        expect(f.fetch.mock.calls[0][0]).toBe('https://api.bilibili.com/x/player/v2?cid=456&bvid=BV1xx411c7mD');
        expect(f.source.status).toBe('empty');
        f.source.retry(); f.source.sync({...f.request, id: 'av123:1', key: 'av123:1'}, 'media'); await settled(f.source);
        expect(f.fetch.mock.calls[1][0]).toBe('https://api.bilibili.com/x/player/v2?cid=456&aid=123');
    });
    it('Udemy Business 从当前公司域读取原文，CDN 请求不携带凭据', async () => {
        const f = sourceFixture(udemy, [{id: 77, locale: {locale: 'en_US'}}, {asset: {captions: [caption('zh_CN'), caption()]}}, vtt]);
        f.source.sync(f.request, 'media'); await settled(f.source);
        expect(f.source.cues).toEqual([cue]); expect(f.source.language).toBe('en-US');
        expect(f.fetch.mock.calls[0][0]).toContain('https://company.udemy.com/api-2.0/courses/programming/');
        expect(f.fetch.mock.calls[1][0]).toContain('/subscribed-courses/77/lectures/123/');
        const calls = f.fetch.mock.calls as unknown as [string, RequestInit][];
        expect(calls.map(call => call[1].credentials)).toEqual(['include', 'include', 'omit']);
    });
    it.each([
        [{id: 'wrong'}], [{id: 0}], [{id: 77}], [{id: 77, locale: {locale: ''}}],
        [{id: 77, locale: {locale: 'en'}}, {}],
        [{id: 77, locale: {locale: 'en'}}, {asset: {captions: [caption()]}}, 'wrong format'],
    ])('Udemy 元数据或格式异常可重试且不冒充无字幕 %j', async (...bodies) => {
        const f = sourceFixture(udemy, bodies); f.source.sync(f.request, 'media'); await settled(f.source); expect(f.source.status).toBe('error');
    });
    it('Udemy 没有原语言字幕时不翻译机译轨，空 edX 时间轴保持空状态', async () => {
        const f = sourceFixture(udemy, [{id: 77, locale: {locale: 'en'}}, {asset: {captions: [caption('zh_CN')]}}]);
        f.source.sync(f.request, 'media'); await settled(f.source); expect(f.source.status).toBe('empty'); expect(f.fetch).toHaveBeenCalledTimes(2);
        const empty = sourceFixture(edx, [{start: [], text: []}]); empty.source.sync(empty.request, 'm'); await settled(empty.source); expect(empty.source.status).toBe('empty');
    });
});

function bridgePage() {
    const page = new EventTarget() as unknown as Window & {player?: {getManifest(): unknown}};
    Object.assign(page, {location: bili, postMessage: vi.fn()});
    const message = (data: unknown, origin = bili.origin, source: unknown = page) => page.dispatchEvent(Object.assign(new Event('message'), {data, origin, source}));
    return {page, message, post: page.postMessage as ReturnType<typeof vi.fn>};
}
describe('只读 B 站播放器桥', () => {
    it('只接受同窗口同源请求，播放器与分 P 一致后才回答；重复安装和 BFCache 可恢复', () => {
        const f = bridgePage(); vi.stubGlobal('window', f.page);
        const dispose = startBilibiliCaptionBridgeApp(); expect(installBilibiliCaptionBridge(f.page)).toBe(dispose);
        const request = {type: 'fluent-read:bilibili-caption-manifest:request', requestId: 'id', part: 'BV1xx411c7mD:2'};
        f.message(request); expect(f.post).not.toHaveBeenCalled();
        f.page.player = {getManifest: () => { throw new Error('not ready'); }}; f.message(request);
        f.page.player = {getManifest: () => ({bvid: 'BV1xx411c7mD', aid: 123, p: 2, cid: 456})};
        for (const data of [null, {}, {...request, requestId: 1}, {...request, requestId: 'x'.repeat(101)}, {...request, part: 1}, {...request, part: 'BV1xx411c7mD:1'}]) f.message(data);
        f.message(request, 'https://evil.test'); f.message(request, bili.origin, null); expect(f.post).not.toHaveBeenCalled();
        f.message(request); expect(f.post).toHaveBeenLastCalledWith({type: 'fluent-read:bilibili-caption-manifest:response', requestId: 'id', part: request.part, cid: 456}, bili.origin);
        f.message({...request, part: 'av123:2'}); expect(f.post).toHaveBeenCalledTimes(2);
        f.page.player = {getManifest: () => ({bvid: 'BV1xx411c7mD', p: 2, cid: 0})}; f.message(request);
        f.page.player = {getManifest: () => ({bvid: 'BV1xx411c7mD', p: 2, cid: '456'})}; f.message(request); expect(f.post).toHaveBeenCalledTimes(2);
        f.page.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: true})); f.message(request); expect(f.post).toHaveBeenCalledTimes(2);
        f.page.dispatchEvent(new Event('pageshow'));
        f.page.player = {getManifest: () => ({bvid: 'BV1xx411c7mD', p: 2, cid: 456})}; f.message(request); expect(f.post).toHaveBeenCalledTimes(3);
        f.page.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: false})); f.message(request); expect(f.post).toHaveBeenCalledTimes(3); dispose();
    });
    it('客户端拒绝错误编号、分 P、来源和 CID，成功后不再轮询', async () => {
        vi.useFakeTimers(); const f = bridgePage(), controller = new AbortController();
        const pending = requestBilibiliCaptionManifest(f.page, 'av123:2', controller.signal);
        const request = f.post.mock.calls[0][0];
        const reply = {...request, type: 'fluent-read:bilibili-caption-manifest:response', cid: 456};
        for (const data of [{}, {...reply, requestId: 'other'}, {...reply, part: 'av123:1'}, {...reply, cid: '456'}, {...reply, cid: 0}]) f.message(data);
        f.message(reply, 'https://evil.test'); f.message(reply, bili.origin, null);
        await vi.advanceTimersByTimeAsync(250); expect(f.post).toHaveBeenCalledTimes(2);
        f.message(reply); await expect(pending).resolves.toBe(456);
        await vi.advanceTimersByTimeAsync(6000); expect(f.post).toHaveBeenCalledTimes(2); controller.abort();
    });
    it('客户端超时、读取中取消与预先取消均释放监听器', async () => {
        vi.useFakeTimers(); const f = bridgePage(), controller = new AbortController();
        const timed = requestBilibiliCaptionManifest(f.page, 'av123:2', controller.signal); const rejected = expect(timed).rejects.toThrow('超时');
        await vi.advanceTimersByTimeAsync(5000); await rejected;
        const aborted = requestBilibiliCaptionManifest(f.page, 'av123:2', controller.signal); const canceled = expect(aborted).rejects.toMatchObject({name: 'AbortError'});
        controller.abort(); await canceled;
        expect(() => requestBilibiliCaptionManifest(f.page, 'av123:2', controller.signal)).toThrow();
        const count = f.post.mock.calls.length; await vi.advanceTimersByTimeAsync(6000); expect(f.post).toHaveBeenCalledTimes(count);
    });
});

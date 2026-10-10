import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {Config} from '@/src/core/config/model';
import {createVideoSubtitleDownloads, planVideoSubtitleExport} from '@/src/features/video-subtitle/content/downloads';

vi.mock('@/src/services/config/store', () => ({config: {uiLanguage: 'zh-CN'}}));
import {confirmVideoSubtitleExport} from '@/src/features/video-subtitle/content/exportPrompt';

type Ports = Parameters<typeof createVideoSubtitleDownloads>[0];
const cue = {startMs: 0, durationMs: 1000, text: 'Original caption.'};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture(overrides: Partial<Ports> = {}) {
    const {document} = parseHTML('<html><body><button></button><div id="menu"></div></body></html>');
    const config = new Config(); config.on = true; config.to = 'zh-Hans';
    const save = vi.fn(), status = vi.fn(), translate = vi.fn(async (source: string) => `译文：${source}`), remember = vi.fn();
    const ports: Ports = {config, document, location: new URL('https://www.youtube.com/watch?v=abc'), request: vi.fn(),
        isX: () => false, isDisposed: () => false, isAiActive: () => false, nativeX: () => null, aiCues: () => [],
        captured: () => [{url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', cues: [cue]}],
        human: {ready: async () => undefined, at: () => ''}, translate, remember, peek: () => undefined, confirm: vi.fn(async () => 'complete' as const), ui: key => key, status, save, ...overrides};
    const downloads = createVideoSubtitleDownloads(ports);
    return {ports, downloads, config, save, status, translate, remember, document,
        button: document.querySelector('button')! as unknown as HTMLButtonElement,
        menu: document.getElementById('menu')! as unknown as HTMLElement};
}

describe('字幕下载与人工轨优先', () => {
    it.each(['cancel', 'media', 'destroy'])('原文下载 %s 后拒绝迟到轨道写入和保存', async invalidation => {
        let media = 'first', complete!: (response: Response) => void;
        const f = fixture({captured: () => [], contextKey: () => media,
            request: vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }))});
        const script = f.document.createElement('script');
        script.textContent = 'var ytInitialPlayerResponse={"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en"}]}}};';
        f.document.body.appendChild(script);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const run = f.downloads.original(f.menu, f.button, () => '取消');
        if (invalidation === 'cancel') f.downloads.cancel();
        else if (invalidation === 'destroy') f.downloads.destroy();
        else media = 'second';
        complete(new Response(JSON.stringify({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: cue.text}]}]})));
        await run;
        expect(f.remember).not.toHaveBeenCalled();
        expect(f.save).not.toHaveBeenCalled();
        expect(f.button.getAttribute('aria-busy')).toBeNull();
        f.downloads.destroy();
        warn.mockRestore();
    });
    it('首条补译失败立即释放任务、中止兄弟等待并保持原失败反馈', async () => {
        const cues = [0, 1, 2].map(index => ({...cue, startMs: index * 1000, text: `Different ${index}.`}));
        const cancelTranslations = vi.fn();
        const late: ((value: string) => void)[] = [];
        const f = fixture({captured: () => [{url: 'https://www.youtube.com/api/timedtext?lang=en', cues}], cancelTranslations,
            translate: source => source.endsWith('0.') ? Promise.reject(new Error('首错')) : new Promise(resolve => {late.push(resolve);})});
        let settled = false;
        const run = f.downloads.translated(f.menu, f.button, false).then(() => {settled = true;});
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true); expect(f.button.getAttribute('aria-busy')).toBeNull();
        expect(f.status).toHaveBeenLastCalledWith(f.menu, 'video.downloadFailed', 2200);
        expect(cancelTranslations).toHaveBeenCalledOnce();
        const count = f.status.mock.calls.length;
        late.forEach(resolve => resolve('迟到译文')); await run; await vi.advanceTimersByTimeAsync(0);
        expect(f.save).not.toHaveBeenCalled(); expect(f.status).toHaveBeenCalledTimes(count); f.downloads.destroy();
    });
    it('原文同步取消的挂起请求结束，旧任务不能覆盖新任务按钮', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const f = fixture({captured: () => []});
        const script = f.document.createElement('script');
        script.textContent = 'var ytInitialPlayerResponse={"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en"}]}}};';
        f.document.body.appendChild(script);
        f.ports.request = vi.fn(() => {f.downloads.cancel(); return new Promise<Response>(() => undefined);});
        await f.downloads.original(f.menu, f.button, () => '取消');
        expect(f.button.getAttribute('aria-busy')).toBeNull(); expect(f.save).not.toHaveBeenCalled();
        let finish!: (value: Response) => void;
        f.ports.request = vi.fn(() => new Promise<Response>(resolve => {finish = resolve;}));
        const old = f.downloads.original(f.menu, f.button, () => '旧取消');
        f.ports.captured = () => [{url: 'https://www.youtube.com/api/timedtext?lang=en', cues: [cue]}];
        const next = f.downloads.original(f.menu, f.button, () => '取消');
        await next; await old;
        finish(new Response(JSON.stringify({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: '旧轨'}]}]})));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.save).toHaveBeenCalledOnce(); expect(f.remember).not.toHaveBeenCalled();
        f.downloads.destroy(); warn.mockRestore();
    });
    it('原文等待期间源语言变化拒绝导出，初始化已销毁的任务也不启动', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const f = fixture();
        f.ports.captured = () => {f.config.from = 'ja'; return [{url: 'https://www.youtube.com/api/timedtext?lang=en', cues: [cue]}];};
        await f.downloads.original(f.menu, f.button, () => '源语言变化'); expect(f.save).not.toHaveBeenCalled();
        f.downloads.destroy(); await f.downloads.original(f.menu, f.button, () => '已销毁');
        expect(f.save).not.toHaveBeenCalled(); warn.mockRestore();
    });
    it('销毁先取消已有反馈，并拒绝迟到原文导出的按钮恢复', async () => {
        const refreshButtons = vi.fn();
        const f = fixture({refreshButtons});
        f.button.disabled = true;
        f.downloads.restoreButton(f.button, 2400);
        expect(vi.getTimerCount()).toBe(1);
        f.downloads.destroy();
        f.downloads.destroy();
        expect(vi.getTimerCount()).toBe(0);
        // 原文 resolve 的 finally 可迟于卸载；本地销毁状态不能依赖外部端口同步变化。
        expect(f.ports.isDisposed()).toBe(false);
        f.downloads.restoreButton(f.button, 3200);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(3200);
        expect(refreshButtons).not.toHaveBeenCalled();
        expect(f.button.disabled).toBe(true);
    });
    it('外部页面在反馈期间失效时不刷新界面或重新登记反馈', async () => {
        let disposed = false;
        const refreshButtons = vi.fn();
        const f = fixture({refreshButtons, isDisposed: () => disposed});
        f.button.disabled = true;
        f.downloads.restoreButton(f.button);
        disposed = true;
        await vi.advanceTimersByTimeAsync(2200);
        expect(refreshButtons).not.toHaveBeenCalled();
        expect(f.button.disabled).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        f.downloads.restoreButton(f.button);
        expect(vi.getTimerCount()).toBe(0);
        f.downloads.destroy();
    });
    it('旧导出反馈交还当前菜单状态，不强制启用重新识别中的按钮', async () => {
        const refreshButtons = vi.fn(() => {f.button.disabled = true;});
        const f = fixture({refreshButtons});
        await f.downloads.translated(f.menu, f.button, false);
        expect(f.save).toHaveBeenCalledOnce();
        expect(f.button.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(2200);
        expect(refreshButtons).toHaveBeenCalledOnce();
        expect(f.button.disabled).toBe(true);
        // 原文也复用相同的反馈归属；卸载取消尚未结束的反馈。
        f.downloads.restoreButton(f.button, 2400);
        f.downloads.destroy();
        await vi.advanceTimersByTimeAsync(2400);
        expect(refreshButtons).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('YouTube 没有来源资格重算时取消导出仍恢复按钮，旧定时器不覆盖新忙碌任务', async () => {
        const f = fixture({refreshButtons: vi.fn(), confirm: async () => 'cancel'});
        await f.downloads.translated(f.menu, f.button, false);
        await vi.advanceTimersByTimeAsync(2200);
        expect(f.button.disabled).toBe(false);
        f.downloads.restoreButton(f.button);
        f.button.disabled = true; f.button.setAttribute('aria-busy', 'true');
        await vi.advanceTimersByTimeAsync(2200);
        expect(f.button.disabled).toBe(true); f.downloads.destroy();
    });
    it('完整 AI 字幕的识别预览不导出，识别完成后才提供完整时间轴', async () => {
        let complete = false;
        const f = fixture({isX: () => true, isAiActive: () => true, isAiComplete: () => complete, aiCues: () => [cue]});
        await expect(f.downloads.resolve()).rejects.toThrow('video.sourcePreparing');
        expect(f.save).not.toHaveBeenCalled();
        complete = true;
        await expect(f.downloads.resolve()).resolves.toEqual({languageCode: 'ai', cues: [cue]});
        f.downloads.destroy();
    });
    it('原文选择当前捕获的原始轨，缺少语言时保留原文标记', async () => {
        const original = fixture({captured: () => [
            {url: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh&tlang=zh', cues: [{...cue, text: '机器轨'}]},
            {url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', cues: [cue]},
        ]});
        expect(await original.downloads.resolve()).toEqual({languageCode: 'en', cues: [cue]});
        const translated = fixture({captured: () => [{url: 'https://www.youtube.com/api/timedtext?tlang=zh', cues: [cue]}]});
        expect((await translated.downloads.resolve()).languageCode).toBe('original');
    });

    it('X 优先主动 AI、原生轨、捕获轨和已识别时间轴，没有字幕时给出说明', async () => {
        const native = {languageCode: 'en', cues: [cue]};
        const active = fixture({isX: () => true, isAiActive: () => true, aiCues: () => [cue], nativeX: () => native});
        expect((await active.downloads.resolve()).languageCode).toBe('ai');
        const source = fixture({isX: () => true, nativeX: () => native});
        expect(await source.downloads.resolve()).toBe(native);
        const captured = fixture({isX: () => true, nativeX: () => ({languageCode: 'en', cues: []})});
        expect((await captured.downloads.resolve()).languageCode).toBe('original');
        const cached = fixture({isX: () => true, captured: () => [{url: 'x:native', cues: []}], aiCues: () => [cue]});
        expect((await cached.downloads.resolve()).languageCode).toBe('ai');
        const empty = fixture({isX: () => true, isAiActive: () => true, captured: () => []});
        await expect(empty.downloads.resolve()).rejects.toThrow('还没有可下载');
    });

    it('没有捕获轨时从当前 YouTube 初始化数据读取轨道，并记住完整时间轴', async () => {
        const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: cue.text}]}]})));
        const f = fixture({captured: () => [], request});
        const script = f.document.createElement('script');
        script.textContent = 'var ytInitialPlayerResponse={"videoDetails":{"videoId":"abc"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en"}]}}};';
        f.document.body.appendChild(script);
        expect(await f.downloads.resolve()).toEqual({languageCode: 'en', cues: [cue]});
        expect(f.remember).toHaveBeenCalledOnce();
        request.mockResolvedValueOnce(new Response('', {status: 503}));
        await expect(f.downloads.resolve()).rejects.toThrow('503');
        request.mockResolvedValueOnce(new Response('{}'));
        await expect(f.downloads.resolve()).rejects.toThrow('完整字幕');
        f.ports.isDisposed = () => true; request.mockResolvedValueOnce(new Response('{}'));
        await expect(f.downloads.resolve()).rejects.toMatchObject({name: 'AbortError'});
        const empty = fixture({captured: () => []}); await expect(empty.downloads.resolve()).rejects.toThrow('没有可用');
    });

    it('导出双语时使用人工字幕，仅为没有人工字幕的句子请求翻译', async () => {
        const second = {...cue, startMs: 1000, text: 'Second original.'};
        const f = fixture({captured: () => [{url: 'https://www.youtube.com/api/timedtext?lang=en', cues: [cue, second]}],
            human: {ready: async () => undefined, at: time => time < 1000 ? '人工字幕' : ''}});
        await f.downloads.translated(f.menu, f.button, true);
        expect(f.translate).toHaveBeenCalledOnce(); expect(f.translate).toHaveBeenCalledWith(second.text);
        expect(f.save).toHaveBeenCalledWith([{...cue, text: 'Original caption.\n人工字幕'}, {...second, text: 'Second original.\n译文：Second original.'}], 'zh-Hans-bilingual');
        expect(f.button.getAttribute('aria-busy')).toBeNull();
        await vi.advanceTimersByTimeAsync(2200); expect(f.button.disabled).toBe(false); f.downloads.destroy();
    });

    it('关闭人工字幕优先后按配置使用服务，目标为空时仍能命名译文下载', async () => {
        const f = fixture({human: {ready: async () => undefined, at: () => '人工字幕'}});
        f.config.videoPreferHumanSubtitles = false; f.config.to = '';
        await f.downloads.translated(f.menu, f.button, false);
        expect(f.translate).toHaveBeenCalledOnce(); expect(f.translate).toHaveBeenCalledWith(cue.text);
        expect(f.save).toHaveBeenCalledWith([{...cue, text: '译文：Original caption.'}], 'translated-translated'); f.downloads.destroy();
    });

    it('关闭功能、翻译失败或取消时不导出，按钮反馈不会遗留计时器', async () => {
        const disabled = fixture(); disabled.config.on = false;
        await disabled.downloads.translated(disabled.menu, disabled.button, false);
        expect(disabled.status).toHaveBeenCalledWith(disabled.menu, 'video.enableFirst', 2200); disabled.downloads.destroy();
        const off = fixture(); off.config.videoTranslationEnabled = false;
        await off.downloads.translated(off.menu, off.button, false); off.downloads.destroy();
        const failed = fixture({translate: async () => { throw 'failure'; }});
        await failed.downloads.translated(failed.menu, failed.button, false);
        expect(failed.status).toHaveBeenLastCalledWith(failed.menu, 'video.downloadFailed', 2200); expect(failed.save).not.toHaveBeenCalled(); failed.downloads.destroy();
        const disposed = fixture({isDisposed: () => true});
        await disposed.downloads.translated(disposed.menu, disposed.button, false);
        expect(disposed.save).not.toHaveBeenCalled(); expect(disposed.status).not.toHaveBeenCalledWith(disposed.menu, 'video.cancelled', 2200); disposed.downloads.destroy();
        let finish!: (value: string) => void;
        const pending = fixture({translate: () => new Promise<string>(yes => { finish = yes; })});
        const promise = pending.downloads.translated(pending.menu, pending.button, false);
        await vi.advanceTimersByTimeAsync(0); pending.downloads.cancel(); finish('过期译文'); await promise;
        expect(pending.save).not.toHaveBeenCalled(); expect(pending.status).toHaveBeenLastCalledWith(pending.menu, 'video.cancelled', 2200); pending.downloads.destroy();
        const destroyed = fixture({translate: () => new Promise<string>(yes => { finish = yes; })});
        const last = destroyed.downloads.translated(destroyed.menu, destroyed.button, false);
        await vi.advanceTimersByTimeAsync(0); destroyed.ports.isDisposed = () => true; destroyed.downloads.destroy(); finish('迟到译文'); await last;
        expect(destroyed.save).not.toHaveBeenCalled();
    });

    it('并发下载取消上一轮；迟到网络响应与换页结果不得污染当前轨道', async () => {
        let ready!: (response: Response) => void;
        const request = vi.fn().mockImplementationOnce(() => new Promise<Response>(yes => { ready = yes; }))
            .mockResolvedValue(new Response(JSON.stringify({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: cue.text}]}]})));
        const f = fixture({request, captured: () => []});
        const script = f.document.createElement('script');
        script.textContent = 'var ytInitialPlayerResponse={"videoDetails":{"videoId":"abc"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en"}]}}};';
        f.document.body.appendChild(script);
        const first = f.downloads.translated(f.menu, f.button, false); await vi.advanceTimersByTimeAsync(0);
        const second = f.downloads.translated(f.menu, f.button, false);
        ready(new Response('{}')); await Promise.all([first, second]);
        expect(f.save).toHaveBeenCalledOnce(); f.downloads.destroy();
        request.mockImplementationOnce(() => new Promise<Response>(yes => { ready = yes; }));
        const stale = f.downloads.resolve(); (f.ports.location as URL).href = 'https://www.youtube.com/watch?v=another';
        ready(new Response('{}')); await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    });
    it('预览区分人工、缓存与缺失；重复原文只计一次请求且保留时间跨度', () => {
        const cues = [cue, {...cue, startMs: 2000, text: 'Cached'}, {...cue, startMs: 4000, text: 'Missing'}, {...cue, startMs: 6000, text: ' Missing '}];
        const plan = planVideoSubtitleExport(cues, c => c.startMs === 0 ? '人工' : '', source => source === 'Cached' ? '缓存' : undefined);
        expect(plan.preview).toEqual({total: 4, ready: 2, missing: 2, requests: 1, human: 1, cached: 1, startMs: 4000, endMs: 7000});
        expect(plan.translations).toEqual(['人工', '缓存', '', '']);
    });
    it('仅导已有结果不补译，跳过缺口但保留原始时间戳与 partial 文件标记', async () => {
        const second = {...cue, startMs: 10000, durationMs: 3000, text: 'Second'};
        const f = fixture({captured: () => [{url: 'https://www.youtube.com/api/timedtext?lang=en', cues: [cue, second]}],
            peek: source => source === second.text ? '已有译文' : undefined, confirm: vi.fn(async () => 'existing' as const)});
        await f.downloads.translated(f.menu, f.button, true);
        expect(f.translate).not.toHaveBeenCalled();
        expect(f.ports.confirm).toHaveBeenCalledWith(f.menu, expect.objectContaining({total: 2, ready: 1, missing: 1, requests: 1, cached: 1}), true, expect.any(AbortSignal));
        expect(f.save).toHaveBeenCalledWith([{...second, text: 'Second\n已有译文'}], 'zh-Hans-bilingual-partial');
        expect(f.status).toHaveBeenLastCalledWith(f.menu, 'video.exportedPartial', 2200);
        f.downloads.destroy();
    });
    it('确认之前不翻译，取消后不保存；确认期间新增缓存被直接复用', async () => {
        let choose!: (value: 'complete' | 'cancel') => void;
        let cached = '';
        const f = fixture({peek: () => cached, confirm: () => new Promise(resolve => {choose = resolve;})});
        const first = f.downloads.translated(f.menu, f.button, false);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.translate).not.toHaveBeenCalled(); choose('cancel'); await first;
        expect(f.save).not.toHaveBeenCalled();
        const second = f.downloads.translated(f.menu, f.button, false);
        await vi.advanceTimersByTimeAsync(0); cached = '新缓存'; choose('complete'); await second;
        expect(f.translate).not.toHaveBeenCalled(); expect(f.save).toHaveBeenCalledWith([{...cue, text: '新缓存'}], 'zh-Hans-translated');
        f.downloads.destroy();
    });
    it.each(['language', 'model', 'glossary', 'prompt', 'headers', 'media', 'page'])('确认期间 %s 改变不能补译或保存旧预览', async change => {
        let choose!: (value: 'complete') => void, media = 'one';
        const f = fixture({contextKey: () => media, confirm: () => new Promise(resolve => {choose = resolve;})});
        const run = f.downloads.translated(f.menu, f.button, false); await vi.advanceTimersByTimeAsync(0);
        const service = f.config.videoService || f.config.service;
        if (change === 'language') f.config.to = 'ja';
        if (change === 'model') f.config.model[service] = 'other-model';
        if (change === 'glossary') f.config.glossaryEnabled = !f.config.glossaryEnabled;
        if (change === 'prompt') f.config.user_role[service] = 'new prompt';
        if (change === 'headers') f.config.customHeaders[service] = '{"x-fixture":"new"}';
        if (change === 'media') media = 'two';
        if (change === 'page') (f.ports.location as URL).href = 'https://www.youtube.com/watch?v=next';
        choose('complete'); await run;
        expect(f.translate).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
        expect(f.status).toHaveBeenLastCalledWith(f.menu, 'video.cancelled', 2200); f.downloads.destroy();
    });
    it('取消立即结束下载，不等待共享缓存请求，迟到结果不会保存', async () => {
        let finish!: (text: string) => void;
        const f = fixture({translate: () => new Promise(resolve => {finish = resolve;})});
        const run = f.downloads.translated(f.menu, f.button, false); await vi.advanceTimersByTimeAsync(0);
        f.downloads.cancel(); await run;
        expect(f.save).not.toHaveBeenCalled(); finish('迟到缓存结果'); await Promise.resolve();
        expect(f.save).not.toHaveBeenCalled(); f.downloads.destroy();
    });
    it.each(['track', 'human', 'translate'])('%s 端口同步取消且永不返回时仍释放下载按钮', async phase => {
        const f = fixture();
        const cancelAndSuspend = () => { f.downloads.cancel(); return new Promise<never>(() => undefined); };
        if (phase === 'track') {
            f.ports.captured = () => [];
            const script = f.document.createElement('script');
            script.textContent = 'var ytInitialPlayerResponse={"videoDetails":{"videoId":"abc"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en"}]}}};';
            f.document.body.appendChild(script);
            f.ports.request = cancelAndSuspend;
        } else if (phase === 'human') f.ports.human.ready = cancelAndSuspend;
        else f.ports.translate = cancelAndSuspend;
        await f.downloads.translated(f.menu, f.button, false);
        expect(f.button.getAttribute('aria-busy')).toBeNull(); expect(f.save).not.toHaveBeenCalled();
        expect(f.status).toHaveBeenLastCalledWith(f.menu, 'video.cancelled', 2200);
        await vi.advanceTimersByTimeAsync(2200); expect(f.button.disabled).toBe(false); f.downloads.destroy();
    });
    it('人工轨端口同步抛错时清理取消监听并恢复按钮', async () => {
        const f = fixture({human: {ready: () => { throw new Error('manual track failed'); }, at: () => ''}});
        await f.downloads.translated(f.menu, f.button, false);
        expect(f.save).not.toHaveBeenCalled(); expect(f.button.getAttribute('aria-busy')).toBeNull();
        expect(f.status).toHaveBeenLastCalledWith(f.menu, 'video.downloadFailed', 2200); f.downloads.destroy();
    });

    it('真实确认页呈现冻结缺口，禁止伪造点击，选择已有结果后恢复菜单', async () => {
        const parsed = parseHTML('<html><body><div id="menu"><div class="fluent-read-video-menu-main"></div></div></body></html>');
        parsed.window.HTMLElement.prototype.focus = vi.fn();
        const menu = parsed.document.getElementById('menu')! as unknown as HTMLElement;
        menu.dataset.view = 'main';
        const preview = {total: 4, ready: 2, missing: 2, requests: 1, human: 1, cached: 1, startMs: 4000, endMs: 7000};
        const controller = new AbortController();
        const ui = (key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params || {})}`;
        const choice = confirmVideoSubtitleExport(menu, preview, true, controller.signal, ui);
        expect(menu.dataset.view).toBe('export-prompt');
        expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!.hidden).toBe(true);
        expect(menu.textContent).toContain('"requests":1');
        expect(menu.textContent).toContain('"start":"00:00:04"');
        const button = menu.querySelector<HTMLButtonElement>('[data-export-choice="existing"]')!;
        button.dispatchEvent(new parsed.window.Event('click', {bubbles: true}));
        expect(menu.querySelector('[data-export-prompt]')).not.toBeNull();
        const trusted = new parsed.window.Event('click', {bubbles: true}); Object.defineProperty(trusted, 'isTrusted', {value: true});
        button.dispatchEvent(trusted); await expect(choice).resolves.toBe('existing');
        expect(menu.querySelector('[data-export-prompt]')).toBeNull();
        expect(menu.dataset.view).toBe('main'); expect(menu.querySelector<HTMLElement>('.fluent-read-video-menu-main')!.hidden).toBe(false);
    });
    it('确认页取消清理节点与监听，缺少已完成条目时禁止空导出', async () => {
        const parsed = parseHTML('<html><body><div id="menu"></div></body></html>');
        parsed.window.HTMLElement.prototype.focus = vi.fn();
        const menu = parsed.document.getElementById('menu')! as unknown as HTMLElement;
        const preview = {total: 1, ready: 0, missing: 1, requests: 1, human: 0, cached: 0, startMs: 0, endMs: 1000};
        const controller = new AbortController();
        const choice = confirmVideoSubtitleExport(menu, preview, false, controller.signal, key => key);
        expect(menu.querySelector<HTMLButtonElement>('[data-export-choice="existing"]')!.disabled).toBe(true);
        controller.abort(); await expect(choice).resolves.toBe('cancel'); expect(menu.querySelector('[data-export-prompt]')).toBeNull();
        await expect(confirmVideoSubtitleExport(menu, preview, false, controller.signal, key => key)).resolves.toBe('cancel');
    });
    it.each(['text', 'layout', 'focus'])('确认页 %s 回调同步取消仍结束并移除节点', async phase => {
        const parsed = parseHTML('<html><body><div id="menu"></div></body></html>');
        const menu = parsed.document.getElementById('menu')! as unknown as HTMLElement;
        const controller = new AbortController();
        const preview = {total: 1, ready: 0, missing: 1, requests: 1, human: 0, cached: 0, startMs: 0, endMs: 1000};
        parsed.window.HTMLElement.prototype.focus = vi.fn(() => {if (phase === 'focus') controller.abort();});
        if (phase === 'layout') {
            Object.defineProperty(menu.parentElement, 'clientWidth', {value: 640});
            Object.defineProperty(menu.parentElement, 'clientHeight', {value: 360});
            Object.defineProperty(menu, 'scrollHeight', {get: () => {controller.abort(); return 0;}});
        }
        await expect(confirmVideoSubtitleExport(menu, preview, false, controller.signal, key => {
            if (phase === 'text') controller.abort(); return key;
        })).resolves.toBe('cancel');
        expect(menu.querySelector('[data-export-prompt]')).toBeNull(); expect(menu.dataset.view).toBe('main');
    });

    it('补译期间更换提示词或翻译返回空值不能保存完整或部分文件', async () => {
        let finish!: (value: string) => void;
        const f = fixture({translate: () => new Promise(resolve => {finish = resolve;})});
        const run = f.downloads.translated(f.menu, f.button, false); await vi.advanceTimersByTimeAsync(0);
        f.config.system_role[f.config.videoService || f.config.service] = 'changed after request';
        finish('旧提示词译文'); await run; expect(f.save).not.toHaveBeenCalled(); f.downloads.destroy();
        const empty = fixture({translate: async () => ''});
        await empty.downloads.translated(empty.menu, empty.button, false);
        expect(empty.save).not.toHaveBeenCalled(); expect(empty.status).toHaveBeenLastCalledWith(empty.menu, 'video.downloadFailed', 2200); empty.downloads.destroy();
    });
    it('全部缓存无需新增请求，空的已有结果不创建文件', async () => {
        const ready = fixture({peek: () => '已有', confirm: vi.fn(async () => 'complete' as const)});
        await ready.downloads.translated(ready.menu, ready.button, false);
        expect(ready.ports.confirm).toHaveBeenCalledWith(ready.menu, expect.objectContaining({ready: 1, missing: 0, requests: 0}), false, expect.any(AbortSignal));
        expect(ready.translate).not.toHaveBeenCalled(); expect(ready.save).toHaveBeenCalledOnce(); ready.downloads.destroy();
        const empty = fixture({confirm: async () => 'existing'});
        await empty.downloads.translated(empty.menu, empty.button, false);
        expect(empty.translate).not.toHaveBeenCalled(); expect(empty.save).not.toHaveBeenCalled(); expect(empty.status).toHaveBeenLastCalledWith(empty.menu, 'video.exportEmpty', 2200); empty.downloads.destroy();
    });
    it('源轨空白条目不计入补译预览，也不损失有效条目的原始时间轴', async () => {
        const f = fixture({captured: () => [{url: 'https://www.youtube.com/api/timedtext?lang=en', cues: [{...cue, text: '  '}, {...cue, startMs: 5000}]}]});
        await f.downloads.translated(f.menu, f.button, false);
        expect(f.ports.confirm).toHaveBeenCalledWith(f.menu, expect.objectContaining({total: 1, missing: 1, requests: 1}), false, expect.any(AbortSignal));
        expect(f.translate).toHaveBeenCalledOnce(); expect(f.save).toHaveBeenCalledWith([{...cue, startMs: 5000, text: `译文：${cue.text}`}], 'zh-Hans-translated'); f.downloads.destroy();
    });
    it.each([true, false])('无补译缺口的确认页提供 %s 双语选择，完成后恢复可用焦点', async bilingual => {
        const parsed = parseHTML('<html><body><button id="trigger"></button><div id="menu"><div class="fluent-read-video-menu-main"></div></div></body></html>');
        const menu = parsed.document.getElementById('menu')! as unknown as HTMLElement;
        const trigger = parsed.document.getElementById('trigger')!;
        const focus = vi.fn(); trigger.focus = focus;
        parsed.window.HTMLElement.prototype.focus = vi.fn();
        Object.defineProperty(parsed.document, 'activeElement', {value: trigger});
        menu.dataset.view = 'watch';
        const choice = confirmVideoSubtitleExport(menu, {total: 1, ready: 1, missing: 0, requests: 0, human: 0, cached: 1, startMs: null, endMs: null}, bilingual, new AbortController().signal, key => key);
        expect(menu.querySelector('[data-i18n-key="video.exportPreviewRange"]')).toBeNull();
        expect(menu.querySelector<HTMLButtonElement>('[data-export-choice="existing"]')!.hidden).toBe(true);
        const complete = menu.querySelector<HTMLButtonElement>('[data-export-choice="complete"]')!;
        expect(complete.textContent).toBe(bilingual ? 'video.downloadBilingual' : 'video.downloadTranslated');
        const event = new parsed.window.Event('click', {bubbles: true}); Object.defineProperty(event, 'isTrusted', {value: true});
        complete.dispatchEvent(event); await expect(choice).resolves.toBe('complete');
        expect(menu.dataset.view).toBe('watch'); expect(focus).toHaveBeenCalledOnce();
    });
    it.each(['hidden', 'detached', 'menu-hidden'])('确认页退出不强行恢复 %s 的焦点，键盘 Escape 可取消', async mode => {
        const parsed = parseHTML('<html><body><div hidden><button id="trigger"></button></div><div id="menu"></div></body></html>');
        const menu = parsed.document.getElementById('menu')! as unknown as HTMLElement;
        const trigger = parsed.document.getElementById('trigger')!;
        const focus = vi.fn(); trigger.focus = focus;
        parsed.window.HTMLElement.prototype.focus = vi.fn();
        Object.defineProperty(parsed.document, 'activeElement', {value: trigger});
        const choice = confirmVideoSubtitleExport(menu, {total: 1, ready: 0, missing: 1, requests: 1, human: 0, cached: 0, startMs: null, endMs: null}, false, new AbortController().signal, key => key);
        if (mode === 'detached') trigger.remove();
        if (mode === 'menu-hidden') menu.hidden = true;
        const panel = menu.querySelector<HTMLElement>('[data-export-prompt]')!;
        const key = (value: string, trusted: boolean) => {
            const event = new parsed.window.Event('keydown', {bubbles: true}); Object.defineProperties(event, {key: {value}, isTrusted: {value: trusted}}); panel.dispatchEvent(event);
        };
        key('Escape', false); key('Enter', true); expect(menu.querySelector('[data-export-prompt]')).not.toBeNull();
        key('Escape', true); await expect(choice).resolves.toBe('cancel'); expect(focus).not.toHaveBeenCalled();
    });
    it('禁用按钮、空白和菜单外的动作目标不会误触补译，取消按钮可结束', async () => {
        const parsed = parseHTML('<html><body><div id="menu"></div></body></html>');
        parsed.window.HTMLElement.prototype.focus = vi.fn();
        const menu = parsed.document.getElementById('menu')! as unknown as HTMLElement;
        const choice = confirmVideoSubtitleExport(menu, {total: 1, ready: 0, missing: 1, requests: 1, human: 0, cached: 0, startMs: 0, endMs: null}, false, new AbortController().signal, key => key);
        const click = (element: HTMLElement) => {const event = new parsed.window.Event('click', {bubbles: true}); Object.defineProperty(event, 'isTrusted', {value: true}); element.dispatchEvent(event);};
        click(menu.querySelector<HTMLButtonElement>('[data-export-choice="existing"]')!);
        const panel = menu.querySelector<HTMLElement>('[data-export-prompt]')!;
        click(panel); menu.dataset.exportChoice = 'complete'; click(panel);
        expect(menu.querySelector('[data-export-prompt]')).not.toBeNull();
        click(menu.querySelector<HTMLButtonElement>('[data-export-choice="cancel"]')!); await expect(choice).resolves.toBe('cancel');
    });

    it('另一种导出取代旧任务时释放旧按钮，但不覆盖新下载状态', async () => {
        let finish!: (text: string) => void;
        const translate = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => {finish = resolve;}))
            .mockResolvedValue('新下载译文');
        const f = fixture({translate});
        const first = f.downloads.translated(f.menu, f.button, false); await vi.advanceTimersByTimeAsync(0);
        const secondButton = f.document.createElement('button') as unknown as HTMLButtonElement;
        f.document.body.appendChild(secondButton);
        await f.downloads.translated(f.menu, secondButton, true); await first;
        expect(f.button.getAttribute('aria-busy')).toBeNull(); expect(secondButton.getAttribute('aria-busy')).toBeNull();
        expect(f.save).toHaveBeenCalledOnce(); expect(f.status).toHaveBeenLastCalledWith(f.menu, 'video.downloaded', 2200);
        finish('旧任务结果'); await vi.advanceTimersByTimeAsync(2200);
        expect(f.button.disabled).toBe(false); expect(secondButton.disabled).toBe(false); expect(f.save).toHaveBeenCalledOnce(); f.downloads.destroy();
    });
    it('原文下载成功或失败的反馈与等待计时器由下载协调器管理', async () => {
        const ready = fixture(); const errorMessage = vi.fn(() => '原文读取失败');
        await ready.downloads.original(ready.menu, ready.button, errorMessage);
        expect(ready.save).toHaveBeenCalledWith([cue], 'en'); expect(errorMessage).not.toHaveBeenCalled();
        expect(ready.status).toHaveBeenLastCalledWith(ready.menu, 'video.downloaded', 2400);
        await vi.advanceTimersByTimeAsync(2400); expect(ready.button.disabled).toBe(false); ready.downloads.destroy();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const missing = fixture({captured: () => []});
        await missing.downloads.original(missing.menu, missing.button, errorMessage);
        expect(errorMessage).toHaveBeenCalledOnce(); expect(missing.save).not.toHaveBeenCalled();
        expect(missing.status).toHaveBeenLastCalledWith(missing.menu, '原文读取失败', 3200);
        missing.downloads.destroy(); warn.mockRestore();
    });
    it.each(['current', 'busy-cleared', 'disposed', 'page', 'media'])('慢速原文读取 %s 状态不留下过期导出或提示', async mode => {
        let finish!: (response: Response) => void, disposed = false, media = 'first';
        const f = fixture({captured: () => [], request: () => new Promise(resolve => {finish = resolve;}),
            isDisposed: () => disposed, contextKey: () => media});
        const script = f.document.createElement('script');
        script.textContent = 'var ytInitialPlayerResponse={"videoDetails":{"videoId":"abc"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en","languageCode":"en"}]}}};';
        f.document.body.appendChild(script);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const run = f.downloads.original(f.menu, f.button, () => '原文已失效');
        if (mode === 'busy-cleared') f.button.removeAttribute('aria-busy');
        if (mode === 'disposed') disposed = true;
        if (mode === 'page') (f.ports.location as URL).href = 'https://www.youtube.com/watch?v=next';
        if (mode === 'media') media = 'next';
        await vi.advanceTimersByTimeAsync(2000);
        expect(f.status.mock.calls.some(call => call[1] === 'video.reading')).toBe(mode !== 'busy-cleared' && mode !== 'disposed');
        finish(new Response(JSON.stringify({events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: cue.text}]}]})));
        await run;
        expect(f.save).toHaveBeenCalledTimes(mode === 'current' || mode === 'busy-cleared' ? 1 : 0);
        if (mode === 'disposed') expect(f.status).toHaveBeenCalledTimes(1);
        f.downloads.destroy(); warn.mockRestore();
    });

});

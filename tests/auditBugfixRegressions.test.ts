/**
 * @file tests/auditBugfixRegressions.test.ts
 * 文件职责：为全链路解耦与缺陷审计中修复的并发、边界、缓存、取消、排版与输入法回归提供最小可执行验证。
 * 主要内容：覆盖配置持久化客户端序列上限、计数与保存队列串行化、翻译缓存按 key 隔离与并发一致性、Google 请求门禁超时分类、Offscreen 播放暂停竞态、文档 XML 安全解码与 PDF 图形/列宽修复、富文本目录快速扫描、句子高亮空闲短路、信息高亮空 body 守卫、快捷翻译 IME 拦截及词汇库领域错误码透传。
 * 模块边界：仅使用真实生产模块与最小确定性桩（假时钟、内存存储、linkedom），不访问在线网络或真实浏览器 profile。
 */
import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createConfigPersistenceHandler} from '@/src/app/background/handlers/configPersistence';
import {createConfigAuthority} from '@/src/services/config/authority';
import {createConfigHistoryRuntime} from '@/src/services/config/historyRuntime';
import {createConfigMutationClient} from '@/src/services/config/mutationClient';
import {normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import type {ConfigStoragePort} from '@/src/platform/storage/configStorage';
import {translationCache, translationCacheDb} from '@/src/services/translation/cache';
import {createGoogleRequestGate} from '@/src/providers/translation/googleRequestGate';
import {SelectionTtsPlayer} from '@/src/app/offscreen/ttsPlayback';
import {xmlDecode} from '@/src/features/document-translation/services/binary';
import {analyzePdfPageLayout} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
import {findActiveRichOutlineIndex} from '@/src/features/document-translation/ui/richPreviewSync';
import {installBilingualSentenceHighlight} from '@/src/features/full-page-translation/content/sentenceHighlight';
import {installInformationHighlight} from '@/src/features/information-highlight/content/runtime';
import {mountQuickTranslationContentFeature} from '@/src/features/quick-translation/content';
import {createVocabularyBookHandler} from '@/src/features/vocabulary/background/handler';
import {VocabularyBookError} from '@/src/features/vocabulary/repository';
import {VOCABULARY_BOOK_MESSAGE} from '@/src/features/vocabulary/protocol';
import {DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES} from '@/src/core/config/informationHighlight';
import {calculateSelectionPopupPosition} from '@/src/features/selection-translation/domain/popupPosition';
import {mountParagraphCopyContentFeature} from '@/src/features/paragraph-copy/content';
import {config as runtimeStoreConfig} from '@/src/services/config/store';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('全链路审计缺陷回归', () => {
    it('configPersistence 限制历史 clientId 映射规模且不驱逐活跃客户端', async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {releaseFirst = resolve;});
        let revision = 1;
        let firstBlocked = false;
        const handler = createConfigPersistenceHandler({
            ready: Promise.resolve(),
            getCurrentConfig: () => ({theme: 'light'}),
            getCurrentRevision: () => revision,
            prepareConfigSaveRequest: (value) => value as {theme: string},
            prepareConfigPatchRequest: (value) => value as {theme: string},
            saveConfig: async () => {
                if (!firstBlocked) {
                    firstBlocked = true;
                    await firstGate;
                }
                revision += 1;
            },
            isExtensionUrl: () => true,
        });
        const ctx = {sender: {url: 'chrome-extension://id/options.html'}};
        const activePromise = handler.handle({
            type: 'persistConfig', mode: 'replace', clientId: 'client-active', sequence: 1, config: {theme: 'dark'},
        }, ctx);
        for (let i = 0; i < 520; i += 1) {
            void handler.handle({
                type: 'persistConfig', mode: 'replace', clientId: `client-${i}`, sequence: 1, config: {theme: 'dark'},
            }, ctx);
        }
        releaseFirst();
        const result = await activePromise;
        expect(result.success).toBe(true);
        // 超过上限的旧 clientId 被驱逐后，重新提交序号 1 可再次执行而不是误判为已提交。
        const replayEvicted = await handler.handle({
            type: 'persistConfig', mode: 'replace', clientId: 'client-0', sequence: 1, config: {theme: 'dark'},
        }, ctx);
        expect(replayEvicted.success).toBe(true);
    });

    it('authority.incrementConfigCount 串行接入 writeQueue 并在前序写入失败后仍安全递增', async () => {
        const initial = normalizeConfig({to: 'en', count: 5});
        const records = new Map<string, unknown>([
            ['local:config', {...sanitizeConfigCredentials(initial), __fluentConfigRevision: 1}],
            ['local:credentials', extractConfigCredentials(initial)],
        ]);
        let failedOnce = false;
        const port: ConfigStoragePort = {
            writeOwner: true,
            getItem: async <T>(key: string) => structuredClone(records.get(key) ?? null) as T | null,
            setItem: vi.fn(async <T>(key: string, value: T) => {
                if (!failedOnce && (value as {to?: string})?.to === 'ja') {
                    failedOnce = true;
                    throw new Error('transient save failure');
                }
                records.set(key, structuredClone(value));
            }),
            removeItem: vi.fn(async (key: string) => {records.delete(key);}),
            watch: vi.fn(() => () => undefined),
        };
        const authority = createConfigAuthority({
            storage: port,
            trustedContext: false,
            client: () => client,
            history: () => history,
        });
        const history = createConfigHistoryRuntime({
            storage: port,
            ready: () => authority.configReady,
            getConfig: () => authority.config,
            getRevision: authority.getConfigRevision,
            isTrusted: () => false,
            isWriteOwner: () => true,
            commit: authority.restore,
        });
        const client = createConfigMutationClient({
            authority: authority.clientPort,
            applyHistoryAction: history.applyAction,
        });
        await authority.start();
        const failedSave = authority.saveConfig(normalizeConfig({to: 'ja', count: 5})).catch((err) => err);
        await Promise.resolve();
        const incremented = authority.incrementConfigCount(2, 'op-after-fail');
        expect(await failedSave).toBeInstanceOf(Error);
        await expect(incremented).resolves.toBe(7);
        await authority.waitForConfigPersistenceQueue();
        expect(authority.config.count).toBe(7);
    });

    it('translationCache 并发写入其他键不导致 getMany 伪未命中，且支持同键竞态隔离与键修订上限重置', async () => {
        await translationCache.clear();
        await translationCache.set('k-a', '译文A', 1_000);
        await translationCache.set('k-b', '译文B', 1_000);
        // 清空内存热层以强制走 IndexedDB bulkGet。
        (translationCache as unknown as {memory: Map<string, unknown>}).memory.clear();

        let releaseBulkGet!: () => void;
        const bulkGetGate = new Promise<void>((resolve) => {releaseBulkGet = resolve;});
        const originalBulkGet = translationCacheDb.entries.bulkGet.bind(translationCacheDb.entries);
        vi.spyOn(translationCacheDb.entries, 'bulkGet').mockImplementationOnce(((keys: string[]) => (async () => {
            const rows = await originalBulkGet(keys);
            await bulkGetGate;
            return rows;
        })()) as unknown as typeof translationCacheDb.entries.bulkGet);

        const readPromise = translationCache.getMany(['k-a', 'k-b'], 1_100);
        await Promise.resolve();
        // 并发修改 k-b，不修改 k-a；k-a 仍应命中，k-b 因同键变化被跳过。
        await translationCache.set('k-b', '译文B2', 1_200);
        releaseBulkGet();
        await expect(readPromise).resolves.toEqual(['译文A', null]);

        // 超过 512 个不同键时重置 keyRevisions 并推进 pruneRevision，防止映射无界增长。
        const bulkEntries = Array.from({length: 520}, (_, i) => ({key: `cap-${i}`, value: `v-${i}`}));
        await expect(translationCache.setMany(bulkEntries, 2_000)).resolves.toBe(520);
        await translationCache.clear();
    });

    it('googleRequestGate 在冷却结束后因预算到期拒绝时返回截止错误而非 HTTP 429', async () => {
        vi.useFakeTimers();
        const gate = createGoogleRequestGate();
        const firstController = new AbortController();
        const firstLease = await gate.acquire(firstController.signal, Date.now() + 5_000);
        gate.pause({retryAfterMs: 1_000});
        firstLease.finish(false);

        // 推进超过冷却时间，进入恢复探测占位（probing = true）。
        vi.advanceTimersByTime(1_200);
        const probeController = new AbortController();
        const probeLease = await gate.acquire(probeController.signal, Date.now() + 10_000);

        const waiterController = new AbortController();
        const waiter = gate.acquire(waiterController.signal, Date.now() + 500);
        const expectation = expect(waiter).rejects.toThrow('谷歌翻译总请求时间已耗尽');
        vi.advanceTimersByTime(600);
        await expectation;
        probeLease.finish(true);
    });

    it('SelectionTtsPlayer 在 play 尚未 resolve 时收到 pause 后不启动进度计时器', async () => {
        vi.useFakeTimers();
        let resolvePlay!: () => void;
        const fakeAudio = {
            preload: '',
            playbackRate: 1,
            currentTime: 0,
            duration: 10,
            paused: false,
            ended: false,
            play: vi.fn(() => new Promise<void>((resolve) => {resolvePlay = resolve;})),
            pause: vi.fn(() => {fakeAudio.paused = true;}),
            removeAttribute: vi.fn(),
            load: vi.fn(),
            onended: null as (() => void) | null,
            onerror: null as (() => void) | null,
        };
        const notify = vi.fn();
        const player = new SelectionTtsPlayer({
            createAudio: () => fakeAudio as unknown as HTMLAudioElement,
            decodeBase64: () => new Uint8Array([1, 2, 3]),
            createObjectUrl: () => 'blob:mock',
            revokeObjectUrl: vi.fn(),
            notify,
        });
        const playing = player.play({
            tabId: 1,
            clientRequestId: 'req-1',
            audioBase64: btoa('fake'),
            contentType: 'audio/mpeg',
            text: 'hello world',
            rate: 1,
        });
        player.pause({tabId: 1, clientRequestId: 'req-1'});
        resolvePlay();
        await playing;
        vi.advanceTimersByTime(500);
        expect(notify).not.toHaveBeenCalledWith(expect.anything(), 'progress', expect.anything(), expect.anything());
        player.stop({tabId: 1, clientRequestId: 'req-1'});
    });

    it('xmlDecode 安全处理越界数字实体且不对 &#38;lt; 做二次反转义', () => {
        expect(xmlDecode('&#x110000;&#9999999;&#38;lt;tag&#x26;gt;&amp;&quot;&apos;&#65;'))
            .toBe('&#x110000;&#9999999;&lt;tag&gt;&"\'A');
    });

    it('pdfLayoutAnalysis 传递合并重叠图形区域并按字号区分列右边界缓存', () => {
        const layout = analyzePdfPageLayout({
            width: 600,
            height: 800,
            atoms: [
                {text: 'Caption line.', x: 72, y: 100, width: 120, height: 8, fontSize: 8, baseline: 108, fontFamily: 'sans'},
                {text: 'First paragraph ends here.', x: 72, y: 140, width: 180, height: 11, fontSize: 11, baseline: 151, fontFamily: 'sans'},
                {text: 'Second paragraph starts here with a wider line that defines the column edge.', x: 72, y: 158, width: 420, height: 11, fontSize: 11, baseline: 169, fontFamily: 'sans'},
            ],
            graphics: [
                {kind: 'image', x: 72, y: 300, width: 80, height: 60},
                {kind: 'image', x: 200, y: 300, width: 50, height: 30},
                {kind: 'image', x: 140, y: 340, width: 130, height: 90},
            ],
        });
        const figureRegions = layout.preservedRegions.filter((r) => r.kind === 'figure');
        expect(figureRegions).toHaveLength(1);
        expect(figureRegions[0]).toMatchObject({x: 72, y: 300});
        // 8pt 短图注不污染 11pt 正文的列右边界，两段 11pt 正文应保持分块。
        const textBlocks = layout.blocks.filter((b) => b.kind === 'text');
        expect(textBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it('findActiveRichOutlineIndex 在无 clone 扫描下正确跳过译文兄弟标题、空标题、空白标题与内嵌译文节点', () => {
        const {document} = parseHTML(`<!doctype html><html><body>
            <h1></h1>
            <h2><span class="fluentread-translation">仅译文无原文</span></h2>
            <h2>   <span class="fluentread-translation">空白与译文</span></h2>
            <h2 id="s1">Section One</h2>
            <h2 class="fluentread-translation">第一节</h2>
            <h2 id="s2">Section Two<span class="fluentread-translation">第二节</span></h2>
        </body></html>`);
        const headings = Array.from(document.querySelectorAll('h1,h2'));
        const tops = [-200, -150, -100, -50, -20, 120];
        headings.forEach((el, idx) => {
            el.getBoundingClientRect = (() => ({top: tops[idx]})) as unknown as Element['getBoundingClientRect'];
        });
        const frame = {contentDocument: document};
        expect(findActiveRichOutlineIndex(frame, 80)).toBe(3);
        expect(findActiveRichOutlineIndex(frame, 200)).toBe(5);
    });

    it('sentenceHighlight 在页面无活动译文时直接短路 pointermove，不安排 rAF', () => {
        const {window, document} = parseHTML('<!doctype html><html><body><p>Hello</p></body></html>');
        const raf = vi.fn(() => 1);
        Object.assign(window, {
            Highlight: class extends Set {},
            CSS: {highlights: new Map()},
            requestAnimationFrame: raf,
            cancelAnimationFrame: vi.fn(),
        });
        const dispose = installBilingualSentenceHighlight(document);
        const target = document.querySelector('p')!;
        const event = {composedPath: () => [target], clientX: 10, clientY: 10} as unknown as PointerEvent;
        document.dispatchEvent(Object.assign(new window.Event('pointermove'), event));
        expect(raf).not.toHaveBeenCalled();
        dispose();
    });

    it('informationHighlight 在 body 与 documentElement 均缺失时 readDark 安全返回 false 不崩溃', () => {
        vi.useFakeTimers();
        const {window, document} = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(window, {
            Highlight: class extends Set {},
            CSS: {highlights: new Map()},
            getComputedStyle: vi.fn(() => ({color: 'rgb(0, 0, 0)'})),
            MutationObserver: class {observe() {} disconnect() {}},
        });
        Object.defineProperty(document, 'defaultView', {configurable: true, value: window});
        Object.defineProperty(document, 'body', {configurable: true, value: null});
        Object.defineProperty(document, 'documentElement', {configurable: true, value: null});
        const controller = installInformationHighlight(document, {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, enabled: true}, {
            scoreLocal: vi.fn(async () => ({spans: [], engine: 'local'})),
        });
        controller.setEnabled(true);
        vi.advanceTimersByTime(500);
        expect(controller.getState().enabled).toBe(true);
        controller.dispose();
    });

    it('quickTranslation 在 IME 组合输入与 compositionstart 时清理手势并支持快捷键缓存淘汰', () => {
        parseHTML('<!doctype html><html><body><p>Hello</p></body></html>');
        const runFullPage = vi.fn();
        const runHover = vi.fn();
        const runSection = vi.fn();
        const profiles = Array.from({length: 135}, (_, i) => ({
            id: `p-${i}`,
            name: `P${i}`,
            enabled: true,
            action: 'full-page' as const,
            hotkey: `Alt+Shift+${String.fromCharCode(65 + (i % 26))}${i >= 26 ? '' : ''}`,
            service: 'google',
            model: '',
            targetLanguage: 'zh-Hans',
            displayMode: 'bilingual' as const,
            fullPageMode: 'viewport' as const,
        }));
        // 构造 130 个不同合法 hotkey 字符串覆盖缓存清理阈值（>=128）。
        const distinctHotkeys = [
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => `Alt+${k}`),
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => `Control+${k}`),
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => `Shift+${k}`),
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => `Alt+Shift+${k}`),
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => `Control+Shift+${k}`),
            ...'0123456789'.split('').map((k) => `Alt+${k}`),
        ];
        const cfg = {
            on: true,
            quickTranslationProfiles: distinctHotkeys.map((hotkey, idx) => ({
                ...profiles[idx % profiles.length]!,
                id: `hk-${idx}`,
                hotkey,
            })),
        };
        const controller = new AbortController();
        const listeners = new Map<string, ((e: any) => void)[]>();
        const fakeTarget = () => ({
            visibilityState: 'visible',
            addEventListener: (type: string, fn: (e: any) => void) => {
                listeners.set(type, [...(listeners.get(type) ?? []), fn]);
            },
            removeEventListener: vi.fn(),
        });
        mountQuickTranslationContentFeature({
            config: cfg,
            window: fakeTarget() as unknown as Window,
            document: fakeTarget() as unknown as Document,
            isSiteDisabled: () => false,
            isProfileAvailable: () => true,
            shouldReserveSelectionShortcut: () => false,
            getConfiguredSelectionHotkey: () => 'none',
            getCustomSelectionHotkey: () => '',
            hasActiveSelectionTranslationCandidate: () => false,
            resetLegacyKeyboardGestures: vi.fn(),
            cancelPendingHoverTranslation: vi.fn(),
            runHover,
            runFullPage,
            runSection,
            isEditing: () => false,
        }, controller.signal);

        const emit = (type: string, event: Record<string, unknown>) => {
            for (const fn of listeners.get(type) ?? []) fn(event);
        };
        // IME composing keydown & keyup 均被忽略。
        emit('keydown', {isTrusted: true, isComposing: true, key: 'a', code: 'KeyA', altKey: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn()});
        emit('keyup', {isTrusted: true, isComposing: true, key: 'a', code: 'KeyA', altKey: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn()});
        emit('compositionstart', {});
        // 非匹配按键触发遍历全部 140 个不同 hotkey，命中缓存容量重置。
        emit('keydown', {isTrusted: true, isComposing: false, repeat: false, key: 'F12', code: 'F12', altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn()});
        expect(runFullPage).not.toHaveBeenCalled();

        controller.abort();
        // 已中止后再触发 compositionstart 直接返回。
        emit('compositionstart', {});
    });

    it('vocabularyBookHandler 保留 VocabularyBookError 领域错误码且不作为 storage-error 记录', async () => {
        const logOperationFailure = vi.fn();
        const handler = createVocabularyBookHandler({
            configReady: Promise.resolve(),
            isVocabularyBookEnabled: () => true,
            vocabularyBook: {
                upsert: async () => {throw new VocabularyBookError('limit-exceeded', '词书已达上限');},
            } as never,
            broadcastChanged: vi.fn(),
            logOperationFailure,
        });
        const response = await handler.handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'upsert',
            input: {term: 'hello', translation: '你好', sourceLanguage: 'en', targetLanguage: 'zh-Hans'},
        }, {});
        expect(response).toEqual({
            success: false,
            error: {code: 'limit-exceeded', message: '词书已达上限'},
        });
        expect(logOperationFailure).not.toHaveBeenCalled();
    });

    it('configPersistence 在并发活跃客户端释放后批量裁剪超出上限的历史 clientId', async () => {
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => {releaseGate = resolve;});
        let blocked = true;
        let revision = 1;
        const handler = createConfigPersistenceHandler({
            ready: Promise.resolve(),
            getCurrentConfig: () => ({theme: 'light'}),
            getCurrentRevision: () => revision,
            prepareConfigSaveRequest: (value) => value as {theme: string},
            prepareConfigPatchRequest: (value) => value as {theme: string},
            saveConfig: async () => {
                if (blocked) await gate;
                revision += 1;
            },
            isExtensionUrl: () => true,
        });
        const ctx = {sender: {url: 'chrome-extension://id/options.html'}};
        const pending: unknown[] = [];
        for (let i = 0; i < 1026; i += 1) {
            pending.push(handler.handle({
                type: 'persistConfig', mode: 'replace', clientId: `burst-${i}`, sequence: 1, config: {theme: 'dark'},
            }, ctx));
        }
        blocked = false;
        releaseGate();
        await Promise.all(pending);
        // 全部活跃请求完成后再写入新客户端，会一次性淘汰超出上限的多条旧记录。
        const res = await handler.handle({
            type: 'persistConfig', mode: 'replace', clientId: 'burst-final', sequence: 1, config: {theme: 'light'},
        }, ctx);
        expect(res).toEqual({success: true, revision: expect.any(Number)});
    });

    it('popupPosition 在锁定方向空间过窄且对侧显著更宽时触发滞回翻转', () => {
        const flipToTop = calculateSelectionPopupPosition(
            {left: 100, right: 200, top: 680, bottom: 700, width: 100, height: 20},
            {width: 320, height: 260},
            {width: 1000, height: 760},
            12,
            10,
            {preferredPlacement: 'bottom'},
        );
        expect(flipToTop.placement).toBe('top');

        const flipToBottom = calculateSelectionPopupPosition(
            {left: 100, right: 200, top: 40, bottom: 60, width: 100, height: 20},
            {width: 320, height: 260},
            {width: 1000, height: 760},
            12,
            10,
            {preferredPlacement: 'top'},
        );
        expect(flipToBottom.placement).toBe('bottom');

        const stayBottom = calculateSelectionPopupPosition(
            {left: 100, right: 200, top: 100, bottom: 120, width: 100, height: 20},
            {width: 320, height: 200},
            {width: 1000, height: 760},
            12,
            10,
            {preferredPlacement: 'bottom'},
        );
        expect(stayBottom.placement).toBe('bottom');
    });

    it('paragraphCopy 忽略不可信 pointermove，并在 mouseout 离窗或页面隐藏时清空指针坐标', async () => {
        const {window, document} = parseHTML('<!doctype html><html><body><p>Hello world</p></body></html>');
        vi.stubGlobal('window', window);
        vi.stubGlobal('document', document);
        vi.stubGlobal('HTMLElement', window.HTMLElement);
        vi.stubGlobal('Element', window.Element);
        vi.stubGlobal('Node', window.Node);
        const paragraph = document.querySelector('p')!;
        Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: vi.fn(() => paragraph)});
        let visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', {clipboard: {writeText}});

        const prevConfig = {
            on: runtimeStoreConfig.on,
            paragraphCopyEnabled: runtimeStoreConfig.paragraphCopyEnabled,
            paragraphCopyContent: runtimeStoreConfig.paragraphCopyContent,
            paragraphCopyHotkey: runtimeStoreConfig.paragraphCopyHotkey,
            customParagraphCopyHotkey: runtimeStoreConfig.customParagraphCopyHotkey,
            uiLanguage: runtimeStoreConfig.uiLanguage,
        };
        Object.assign(runtimeStoreConfig, {
            on: true,
            paragraphCopyEnabled: true,
            paragraphCopyContent: 'original',
            paragraphCopyHotkey: 'custom',
            customParagraphCopyHotkey: 'Alt+C',
            uiLanguage: 'zh-CN',
        });

        const controller = new AbortController();
        try {
            mountParagraphCopyContentFeature({
                isSiteDisabled: () => false,
            } as never, controller.signal);

            const dispatch = (target: EventTarget, type: string, props: Record<string, unknown>) => {
                const ev = new window.Event(type);
                for (const [k, v] of Object.entries(props)) {
                    Object.defineProperty(ev, k, {configurable: true, value: v});
                }
                target.dispatchEvent(ev);
            };
            const triggerCopy = async () => {
                dispatch(document, 'keydown', {
                    isTrusted: true,
                    repeat: false,
                    isComposing: false,
                    keyCode: 67,
                    key: 'c',
                    code: 'KeyC',
                    altKey: true,
                    ctrlKey: false,
                    shiftKey: false,
                    metaKey: false,
                    target: document.body,
                });
                await Promise.resolve();
                await Promise.resolve();
            };

            // 不可信 pointermove 不记录坐标
            dispatch(document, 'pointermove', {isTrusted: false, clientX: 50, clientY: 50});
            await triggerCopy();
            expect(writeText).not.toHaveBeenCalled();

            // 可信 pointermove 后，不可信或 relatedTarget 非空的 mouseout 不清除坐标
            dispatch(document, 'pointermove', {isTrusted: true, clientX: 50, clientY: 50});
            dispatch(document, 'mouseout', {isTrusted: false, relatedTarget: null});
            dispatch(document, 'mouseout', {isTrusted: true, relatedTarget: paragraph});
            await triggerCopy();
            expect(writeText).toHaveBeenCalledTimes(1);

            // 可信 mouseout 且 relatedTarget === null 清除坐标
            dispatch(document, 'mouseout', {isTrusted: true, relatedTarget: null});
            await triggerCopy();
            expect(writeText).toHaveBeenCalledTimes(1);

            // visibilitychange 为 visible 保留坐标，为 hidden 清除坐标
            dispatch(document, 'pointermove', {isTrusted: true, clientX: 60, clientY: 60});
            visibility = 'visible';
            dispatch(document, 'visibilitychange', {});
            await triggerCopy();
            expect(writeText).toHaveBeenCalledTimes(2);

            visibility = 'hidden';
            dispatch(document, 'visibilitychange', {});
            await triggerCopy();
            expect(writeText).toHaveBeenCalledTimes(2);
        } finally {
            controller.abort();
            Object.assign(runtimeStoreConfig, prevConfig);
        }
    });
});

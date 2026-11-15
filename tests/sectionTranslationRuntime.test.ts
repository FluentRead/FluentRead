import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

type Listener = {type: string; listener: (event: any) => void; signal?: AbortSignal};

const harness = vi.hoisted(() => ({
    config: {
        on: true,
        uiLanguage: 'zh-CN',
        sectionTranslationHotkeyEnabled: false,
        sectionTranslationHotkey: 'Alt+R',
        customSectionTranslationHotkey: '',
        quickTranslationProfiles: [{id: 'section-1', hotkey: 'Ctrl+R'}],
    } as Record<string, unknown>,
    notices: [] as {message: string; tone: string}[],
    inspect: vi.fn(),
    toggle: vi.fn(),
    ensure: vi.fn(),
    fullPage: vi.fn(() => false),
    save: vi.fn(),
    remind: vi.fn(),
    refresh: vi.fn(),
    subscribe: vi.fn(),
    pause: vi.fn(),
    rememberedPorts: {} as Record<string, any>,
    realRemembered: false,
    startPicker: vi.fn((_options: unknown) => true),
    stopPicker: vi.fn(),
    pickerActive: vi.fn(() => false),
    editing: vi.fn(() => false),
}));

vi.mock('@/src/services/config/store', () => ({config: harness.config, subscribeConfig: harness.subscribe, requestConfigPatch: vi.fn(async (_patch: unknown, send: (msg: unknown) => Promise<unknown>) => {await send({type:'persistConfig'});})}));
vi.mock('@/src/features/section-translation/content/remembered', async importOriginal => {
    const actual = await importOriginal<typeof import('@/src/features/section-translation/content/remembered')>();
    return {createRememberedSectionRuntime: (ports: Parameters<typeof actual.createRememberedSectionRuntime>[0], signal: AbortSignal) => {
        harness.rememberedPorts = ports;
        return harness.realRemembered ? actual.createRememberedSectionRuntime(ports, signal) : {refresh: harness.refresh, pause: harness.pause};
    }};
});
vi.mock('@/src/features/section-translation/content/save', async importOriginal => ({...await importOriginal<typeof import('@/src/features/section-translation/content/save')>(), saveRememberedSection: harness.save}));
vi.mock('@/src/features/section-translation/content/reminder', () => ({showSectionReminder: harness.remind}));
vi.mock('@/src/features/quick-translation/public', () => ({resolveQuickTranslationInvocation: (profile: {id: string}) => ({profileId: profile.id})}));
vi.mock('@/src/core/i18n', () => ({
    normalizeUiLanguage: (value: unknown) => value,
    translate: (key: string, _language: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock('@/src/features/full-page-translation/public', () => ({
    inspectTranslationSection: harness.inspect,
    toggleTranslationSection: harness.toggle,
    ensureTranslationSection: harness.ensure,
    isFullPageTranslationActive: harness.fullPage,
}));
vi.mock('@/src/features/page-notice/public', () => ({
    showPageNotice: (message: string, tone: string) => {
        harness.notices.push({message, tone});
        return {} as HTMLElement;
    },
}));
vi.mock('@/src/shared/dom/editingTarget', () => ({isEditingInPage: harness.editing}));
vi.mock('@/src/features/section-translation/content/picker', () => ({
    startSectionPicker: harness.startPicker,
    stopSectionPicker: harness.stopPicker,
    isSectionPickerActive: harness.pickerActive,
}));

import {SectionRuleSaveError} from '@/src/features/section-translation/content/save';
import {mountSectionTranslationContentFeature, startSectionTranslationPicker} from '@/src/features/section-translation/public';

let listeners: Listener[] = [];
let siteDisabled = false;

function emit(type: string, event: Record<string, unknown> = {}): Record<string, any> {
    const created = {
        type,
        isTrusted: true,
        repeat: false,
        key: 'r',
        code: 'KeyR',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...event,
    };
    for (const entry of listeners.filter((item) => item.type === type && !item.signal?.aborted)) entry.listener(created);
    return created;
}

function mount(): AbortController {
    const controller = new AbortController();
    mountSectionTranslationContentFeature({isSiteDisabled: () => siteDisabled}, controller.signal);
    return controller;
}

function lastPickerOptions(): Record<string, any> {
    return harness.startPicker.mock.calls.at(-1)![0] as Record<string, any>;
}

beforeEach(() => {
    listeners = [];
    siteDisabled = false;
    harness.notices.length = 0;
    harness.realRemembered = false;
    Object.assign(harness.config, {on: true, quickTranslationProfiles: [{id: 'section-1', hotkey: 'Ctrl+R'}], sectionTranslationHotkeyEnabled: false, sectionTranslationHotkey: 'Alt+R', customSectionTranslationHotkey: ''});
    vi.clearAllMocks();
    harness.subscribe.mockReturnValue(vi.fn());
    harness.startPicker.mockReturnValue(true);
    harness.pickerActive.mockReturnValue(false);
    harness.editing.mockReturnValue(false);
    vi.stubGlobal('browser', {runtime: {sendMessage: vi.fn(async () => ({}))}});
    vi.stubGlobal('document', {
        location: {href: 'https://example.com/docs/first'},
        addEventListener: (type: string, listener: (event: any) => void, init?: {signal?: AbortSignal}) => {
            listeners.push({type, listener, signal: init?.signal});
        },
    });
});

afterEach(() => vi.unstubAllGlobals());

describe('局部翻译入口', () => {
    it('refreshes remembered regions on a configuration notification and removes the subscription on abort', () => {
        const stop=vi.fn();harness.subscribe.mockReturnValueOnce(stop);
        const controller=mount();harness.refresh.mockClear();
        harness.subscribe.mock.calls[0][0]();expect(harness.refresh).toHaveBeenCalledOnce();
        controller.abort();expect(stop).toHaveBeenCalledOnce();
    });

    it('保存选择委托权威配置端口，失败保留选择并说明原因，路由使旧确认失效', async () => {
        const controller = mount(); startSectionTranslationPicker();
        const options = lastPickerOptions();
        expect(options.rememberScopes).toEqual({site: 'example.com', path: 'example.com/docs/'});
        harness.save.mockResolvedValueOnce(true);
        expect(await options.onRemember('region', {site: 'example.com', mode: 'auto'})).toBe(true);
        const ports = harness.save.mock.calls.at(-1)![2];
        expect(ports.current()).toBe(true);
        expect(ports.rules()).toBe(harness.config.sectionTranslationRules);
        await ports.persist([]);
        for (const error of [new SectionRuleSaveError('limit'), new Error('offline')]) {
            harness.save.mockRejectedValueOnce(error);
            expect(await options.onRemember('region', {site: 'example.com', mode: 'auto'})).toBe(false);
        }
        expect(harness.notices.map(item => item.message)).toEqual(['sectionTranslation.rules.limit', 'sectionTranslation.rules.saveFailed']);
        emit('fluentread-route-change');
        expect(ports.current()).toBe(false);
        await options.onPick('old');
        expect(harness.toggle).not.toHaveBeenCalled();
        harness.save.mockRejectedValueOnce(new Error('late'));
        harness.notices.length = 0;
        await options.onRemember('old', {site: 'example.com', mode: 'auto'});
        expect(harness.notices).toEqual([]);
        controller.abort();
    });
    it('选择模式中SPA导航先关闭旧选择，再启动目的页记忆规则，独立调度器不被旧禁用快照阻塞', async () => {
        vi.useFakeTimers();
        harness.realRemembered = true;
        const {document: pageDocument} = parseHTML('<html><body><article id="remembered">Foreign article</article></body></html>');
        const location = {href: 'https://example.com/docs/first'};
        Object.defineProperty(pageDocument, 'location', {configurable: true, value: location});
        Object.defineProperty(pageDocument, 'visibilityState', {configurable: true, value: 'visible'});
        pageDocument.addEventListener = ((type: string, listener: (event: any) => void, init?: {signal?: AbortSignal}) => {
            listeners.push({type, listener, signal: init?.signal});
        }) as typeof pageDocument.addEventListener;
        vi.stubGlobal('document', pageDocument);
        const observe = vi.fn(), disconnect = vi.fn();
        vi.stubGlobal('MutationObserver', class {observe = observe; disconnect = disconnect;});
        harness.config.sectionTranslationRules = [{id: 'spa-area', enabled: true, site: 'example.com/docs/', selectors: [['#remembered']], mode: 'auto'}];
        harness.ensure.mockResolvedValue({action: 'translated', failed: 0});
        const controller = mount();
        try {
            startSectionTranslationPicker();
            const previous = lastPickerOptions();
            harness.pickerActive.mockReturnValue(true);
            harness.stopPicker.mockImplementation(() => {harness.pickerActive.mockReturnValue(false);});
            location.href = 'https://example.com/docs/second';
            emit('fluentread-route-change');
            expect(harness.stopPicker).toHaveBeenCalledOnce();
            expect(harness.pickerActive()).toBe(false);
            await vi.advanceTimersByTimeAsync(180);
            expect(harness.ensure).toHaveBeenCalledOnce();
            expect(harness.ensure).toHaveBeenCalledWith([pageDocument.getElementById('remembered')], undefined, expect.any(AbortSignal));
            await previous.onPick('old-route-selection');
            expect(harness.toggle).not.toHaveBeenCalled();
            expect(observe).toHaveBeenCalledTimes(2);
        } finally {
            controller.abort();
            expect(vi.getTimerCount()).toBe(0);
            harness.stopPicker.mockImplementation(() => undefined);
            vi.useRealTimers();
        }
    });

    it('独立方案保存关联；缺少网页地址时保持一次性选择', async () => {
        const controller = mount();
        startSectionTranslationPicker({profileId: 'section-1'});
        harness.save.mockResolvedValueOnce(true);
        await lastPickerOptions().onRemember('region', {site: 'example.com', mode: 'remind'});
        expect(harness.save.mock.calls.at(-1)![2].profileId).toBe('section-1');
        Object.defineProperty(document, 'location', {value: undefined});
        startSectionTranslationPicker();
        expect(lastPickerOptions().rememberScopes).toBeUndefined();
        controller.abort();
    });
    it('自动规则使用只补齐接口，按有效方案解析；失败保留重试，取消后不显示旧错误', async () => {
        const controller = mount(), ports = harness.rememberedPorts;
        expect(ports.href()).toBe('https://example.com/docs/first');
        harness.config.sectionTranslationRules = [];
        expect(ports.rules()).toEqual([]);
        expect(ports.enabled()).toBe(true);
        harness.fullPage.mockReturnValueOnce(true); expect(ports.enabled()).toBe(false);
        const roots: unknown[] = [], signal = new AbortController();
        harness.ensure.mockResolvedValue({action: 'translated', failed: 0});
        await ports.translate(roots, {}, signal.signal);
        expect(harness.ensure).toHaveBeenLastCalledWith(roots, undefined, signal.signal);
        harness.config.quickTranslationProfiles = [{id: 'saved', action: 'section'}];
        await ports.translate(roots, {profileId: 'saved'}, signal.signal);
        expect(harness.ensure).toHaveBeenLastCalledWith(roots, {profileId: 'saved'}, signal.signal);
        await expect(ports.translate(roots, {profileId: 'deleted'}, signal.signal)).rejects.toThrow('section-profile-unavailable');
        for (const result of [{failed: 1}, {action: 'blocked'}, {action: 'cancelled'}]) {
            harness.ensure.mockResolvedValueOnce(result);
            await expect(ports.translate(roots, {}, signal.signal)).rejects.toThrow('section-translation-failed');
        }
        signal.abort(); harness.ensure.mockResolvedValueOnce({failed: 1});
        await expect(ports.translate(roots, {}, signal.signal)).resolves.toBeUndefined();
        const translate = vi.fn(), dismiss = vi.fn(); ports.remind(2, translate, dismiss, signal.signal);
        expect(harness.remind).toHaveBeenCalledWith(expect.objectContaining({count: 2, translate, dismiss, signal: signal.signal}));
        controller.abort();
        expect(ports.enabled()).toBe(false);
    });

    it('未挂载时 Popup 请求如实返回失败；挂载后进入选择模式', () => {
        expect(startSectionTranslationPicker()).toBe(false);
        const controller = mount();
        expect(startSectionTranslationPicker()).toBe(true);
        const options = lastPickerOptions();
        expect(options.initialPoint).toBeNull();
        expect(options.text('sectionTranslation.picker.title')).toBe('sectionTranslation.picker.title');
        expect(options.isEditing).toBe(harness.editing);
        harness.inspect.mockReturnValue({action: 'translate'});
        expect(options.inspect('section')).toEqual({action: 'translate'});
        expect(harness.inspect).toHaveBeenCalledWith('section');
        controller.abort();
    });

    it('总开关关闭、站点停用或已卸载时拒绝进入，卸载时退出正在进行的选择', () => {
        const controller = mount();
        harness.config.on = false;
        expect(startSectionTranslationPicker()).toBe(false);
        harness.config.on = true;
        siteDisabled = true;
        expect(startSectionTranslationPicker()).toBe(false);
        siteDisabled = false;
        harness.startPicker.mockReturnValueOnce(false);
        expect(startSectionTranslationPicker()).toBe(false);

        controller.abort();
        expect(harness.stopPicker).toHaveBeenCalledOnce();
        expect(startSectionTranslationPicker()).toBe(false);
        expect(harness.startPicker).toHaveBeenCalledOnce();
    });

    it('旧实例卸载不会清掉新实例的入口', () => {
        const first = mount();
        const second = mount();
        first.abort();
        expect(startSectionTranslationPicker()).toBe(true);
        second.abort();
        expect(startSectionTranslationPicker()).toBe(false);
    });

    it('快捷键默认关闭；开启后按下即带着指针位置进入选择模式', () => {
        const controller = mount();
        emit('pointermove', {clientX: 120, clientY: 340});
        emit('pointermove', {clientX: 999, clientY: 999, isTrusted: false});
        const ignored = emit('keydown', {altKey: true});
        expect(ignored.preventDefault).not.toHaveBeenCalled();
        expect(harness.startPicker).not.toHaveBeenCalled();

        harness.config.sectionTranslationHotkeyEnabled = true;
        const pressed = emit('keydown', {altKey: true});
        expect(pressed.preventDefault).toHaveBeenCalled();
        expect(pressed.stopPropagation).toHaveBeenCalled();
        const options = lastPickerOptions();
        expect(options.initialPoint).toEqual({x: 120, y: 340});
        // 选择期间再次按下同一组合键即退出。
        expect(options.isExitHotkey({key: 'r', code: 'KeyR', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false})).toBe(true);
        expect(options.isExitHotkey({key: 'x', code: 'KeyX', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false})).toBe(false);
        harness.config.sectionTranslationHotkeyEnabled = false;
        expect(options.isExitHotkey({key: 'r', code: 'KeyR', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false})).toBe(false);
        controller.abort();
    });

    it('伪造、长按、其他组合、选择中、输入中、站点停用或总开关关闭时快捷键让行', () => {
        harness.config.sectionTranslationHotkeyEnabled = true;
        const controller = mount();
        const cases: [Record<string, unknown>, () => void][] = [
            [{altKey: true, isTrusted: false}, () => undefined],
            [{altKey: true, repeat: true}, () => undefined],
            [{altKey: true, shiftKey: true}, () => undefined],
            [{altKey: true}, () => harness.pickerActive.mockReturnValueOnce(true)],
            [{altKey: true}, () => harness.editing.mockReturnValueOnce(true)],
            [{altKey: true}, () => { siteDisabled = true; }],
            [{altKey: true}, () => { siteDisabled = false; harness.config.on = false; }],
        ];
        for (const [event, prepare] of cases) {
            prepare();
            const result = emit('keydown', event);
            expect(result.preventDefault).not.toHaveBeenCalled();
        }
        expect(harness.startPicker).not.toHaveBeenCalled();
        controller.abort();
        harness.config.on = true;
        const afterAbort = emit('keydown', {altKey: true});
        expect(afterAbort.preventDefault).not.toHaveBeenCalled();
    });

    it('点选区域后切换翻译，只在无法完成或需要说明时提示', async () => {
        const controller = mount();
        startSectionTranslationPicker();
        const {onPick} = lastPickerOptions();
        const base = {translated: 0, failed: 0, unchanged: 0, restored: 0};
        const cases: [Record<string, unknown>, {message: string; tone: string} | null][] = [
            [{...base, action: 'empty'}, {message: 'sectionTranslation.notice.empty', tone: 'error'}],
            [{...base, action: 'settled'}, {message: 'sectionTranslation.notice.sameLanguage', tone: 'success'}],
            [{...base, action: 'translated', translated: 3, failed: 2}, {message: 'sectionTranslation.notice.failed:{"count":2}', tone: 'error'}],
            [{...base, action: 'translated', unchanged: 4}, {message: 'sectionTranslation.notice.sameLanguage', tone: 'success'}],
            [{...base, action: 'translated', translated: 5, unchanged: 1}, null],
            [{...base, action: 'translated'}, null],
            [{...base, action: 'restored', restored: 5}, null],
            [{...base, action: 'blocked'}, null],
        ];
        for (const [result, notice] of cases) {
            harness.notices.length = 0;
            harness.toggle.mockResolvedValueOnce(result);
            onPick('picked-section');
            expect(harness.toggle).toHaveBeenLastCalledWith('picked-section', undefined, expect.any(AbortSignal));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(harness.notices).toEqual(notice ? [notice] : []);
        }
        expect(harness.toggle).toHaveBeenCalledTimes(cases.length);
        controller.abort();
    });
});


it('独立快捷方案先选择容器，确认后传递方案，重复触发取消选择', async () => {
    const controller = mount();
    const invocation = {profileId: 'section-1', service: 'google', targetLanguage: 'ja', displayMode: 'bilingual' as const};
    expect(startSectionTranslationPicker(invocation)).toBe(true);
    expect(harness.toggle).not.toHaveBeenCalled();
    const options = lastPickerOptions();
    const key = {key: 'r', code: 'KeyR', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false};
    expect(options.isExitHotkey(key)).toBe(true);
    expect(options.isExitHotkey({...key, key: 'x', code: 'KeyX'})).toBe(false);
    options.inspect('selected-container');
    expect(harness.inspect).toHaveBeenCalledWith('selected-container', undefined, invocation);
    harness.toggle.mockResolvedValue({action: 'translated', translated: 1, failed: 0});
    options.onPick('selected-container');
    await Promise.resolve();
    expect(harness.toggle).toHaveBeenCalledWith('selected-container', invocation, expect.any(AbortSignal));
    harness.pickerActive.mockReturnValue(true);
    expect(startSectionTranslationPicker(invocation)).toBe(true);
    expect(harness.stopPicker).toHaveBeenCalledOnce();
    expect(harness.startPicker).toHaveBeenCalledOnce();
    controller.abort();
});


it('选择期间 Popup 保留当前方案，另一方案会重新选择容器', () => {
    const controller = mount();
    startSectionTranslationPicker({profileId: 'section-1', targetLanguage: 'ja'});
    harness.pickerActive.mockReturnValue(true);
    expect(startSectionTranslationPicker()).toBe(true);
    expect(harness.startPicker).toHaveBeenCalledOnce();
    startSectionTranslationPicker({profileId: 'section-2', targetLanguage: 'fr'});
    expect(harness.stopPicker).toHaveBeenCalledOnce();
    expect(harness.startPicker).toHaveBeenCalledTimes(2);
    const options = lastPickerOptions();
    expect(options.isExitHotkey({key: 'x', code: 'KeyX', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false})).toBe(false);
    controller.abort();
});

describe('局部入口挂载所有权和迟到提示', () => {
    it('区域执行异常给出可重试反馈，新的选择仍可正常确认', async () => {
        const current = mount(); startSectionTranslationPicker();
        harness.toggle.mockRejectedValueOnce(new Error('page changed while scanning'));
        await expect(lastPickerOptions().onPick('changed-section')).resolves.toBeUndefined();
        expect(harness.notices).toEqual([{message: 'translationCenter.requestError', tone: 'error'}]);
        harness.notices.length = 0; startSectionTranslationPicker();
        harness.toggle.mockResolvedValueOnce({action: 'translated', translated: 1, failed: 0});
        await lastPickerOptions().onPick('new-section');
        expect(harness.notices).toEqual([]); current.abort();
    });
    it('退场后迟到的执行异常不再弹出反馈', async () => {
        const current = mount(); startSectionTranslationPicker();
        let reject!: (error: Error) => void;
        harness.toggle.mockReturnValueOnce(new Promise((_resolve, fail) => {reject = fail;}));
        const pending = lastPickerOptions().onPick('old-section'); current.abort();
        reject(new Error('late page failure')); await expect(pending).resolves.toBeUndefined();
        expect(harness.notices).toEqual([]);
    });
    it('替代挂载取消旧区域任务，释放旧监听器，但不取消新挂载', async () => {
        const previous = mount(); startSectionTranslationPicker();
        harness.toggle.mockResolvedValue({action: 'translated', translated: 1, failed: 0});
        await lastPickerOptions().onPick('previous-section');
        const oldSignal = harness.toggle.mock.calls.at(-1)![2] as AbortSignal;
        const oldListeners = [...listeners];
        const current = mount();
        expect(oldSignal.aborted).toBe(true);
        expect(oldListeners.every(entry => entry.signal?.aborted)).toBe(true);
        startSectionTranslationPicker(); await lastPickerOptions().onPick('current-section');
        const newSignal = harness.toggle.mock.calls.at(-1)![2] as AbortSignal;
        previous.abort(); expect(newSignal.aborted).toBe(false);
        current.abort(); expect(newSignal.aborted).toBe(true);
    });
    it('重新进入选择后，旧确认的迟到失败不打断新选择', async () => {
        const current = mount(); startSectionTranslationPicker(); const oldOptions = lastPickerOptions();
        let finish!: (value: unknown) => void;
        harness.toggle.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const pending = oldOptions.onPick('first-section');
        startSectionTranslationPicker();
        finish({action: 'translated', translated: 1, failed: 2}); await pending;
        expect(harness.notices).toEqual([]);
        await oldOptions.onPick('stale-picker-section');
        expect(harness.toggle).toHaveBeenCalledOnce(); current.abort();
    });
    it('同一选择的较早确认结果不会覆盖较新确认', async () => {
        const current = mount(); startSectionTranslationPicker(); const options = lastPickerOptions();
        let finish!: (value: unknown) => void;
        harness.toggle.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const pending = options.onPick('first-section');
        harness.toggle.mockResolvedValueOnce({action: 'translated', translated: 1, failed: 0});
        await options.onPick('second-section');
        finish({action: 'empty'}); await pending;
        expect(harness.notices).toEqual([]); current.abort();
    });
    it('预取消的挂载不登记监听器，也不覆盖仍在使用的入口', () => {
        const current = mount(), count = listeners.length, stopped = new AbortController(); stopped.abort();
        mountSectionTranslationContentFeature({isSiteDisabled: () => false}, stopped.signal);
        expect(listeners).toHaveLength(count); expect(startSectionTranslationPicker()).toBe(true); current.abort();
    });
    it('替代挂载结束旧选择；旧挂载的卸载和键盘事件不影响新选择', () => {
        const previous = mount(); startSectionTranslationPicker(); harness.pickerActive.mockReturnValue(true);
        const current = mount(); expect(harness.stopPicker).toHaveBeenCalledOnce();
        harness.pickerActive.mockReturnValue(false); harness.config.sectionTranslationHotkeyEnabled = true;
        const event = emit('keydown', {altKey: true}); expect(harness.startPicker).toHaveBeenCalledTimes(2); expect(event.preventDefault).toHaveBeenCalledOnce();
        harness.pickerActive.mockReturnValue(true); const before = harness.stopPicker.mock.calls.length; previous.abort();
        expect(harness.stopPicker).toHaveBeenCalledTimes(before); expect(startSectionTranslationPicker()).toBe(true); current.abort();
    });
    it.each(['abort', 'replace', 'disabled', 'site'] as const)('点选后的迟到结果不会在入口失效后重新弹出提示：%s', async reason => {
        const current = mount(); startSectionTranslationPicker(); const options = lastPickerOptions();
        let finish!: (value: unknown) => void; harness.toggle.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        options.onPick('old-section'); let replacement: AbortController | undefined;
        if (reason === 'abort') current.abort(); else if (reason === 'replace') replacement = mount(); else if (reason === 'disabled') harness.config.on = false; else siteDisabled = true;
        finish({action: 'empty'}); for (let i=0;i<4;i++) await Promise.resolve(); expect(harness.notices).toEqual([]);
        replacement?.abort(); current.abort();
    });
    it('退场后的旧回调不会再发出区域翻译请求', () => {
        const current = mount(); startSectionTranslationPicker(); const options = lastPickerOptions(); current.abort();
        options.onPick('detached-section'); expect(harness.toggle).not.toHaveBeenCalled();
    });
});

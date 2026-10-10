import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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
    startPicker: vi.fn((_options: unknown) => true),
    stopPicker: vi.fn(),
    pickerActive: vi.fn(() => false),
    editing: vi.fn(() => false),
}));

vi.mock('@/src/services/config/store', () => ({config: harness.config}));
vi.mock('@/src/core/i18n', () => ({
    normalizeUiLanguage: (value: unknown) => value,
    translate: (key: string, _language: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock('@/src/features/full-page-translation/public', () => ({
    inspectTranslationSection: harness.inspect,
    toggleTranslationSection: harness.toggle,
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
    Object.assign(harness.config, {on: true, sectionTranslationHotkeyEnabled: false, sectionTranslationHotkey: 'Alt+R', customSectionTranslationHotkey: ''});
    vi.clearAllMocks();
    harness.startPicker.mockReturnValue(true);
    harness.pickerActive.mockReturnValue(false);
    harness.editing.mockReturnValue(false);
    vi.stubGlobal('document', {
        addEventListener: (type: string, listener: (event: any) => void, init?: {signal?: AbortSignal}) => {
            listeners.push({type, listener, signal: init?.signal});
        },
    });
});

afterEach(() => vi.unstubAllGlobals());

describe('局部翻译入口', () => {
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

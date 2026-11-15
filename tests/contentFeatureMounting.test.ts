import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
    config: {
        on: true,
        harness: undefined as {enabled: boolean} | undefined,
        disableSelectionTranslator: false,
        selectionTranslatorMode: 'bilingual',
        selectionAreaEnabled: true,
    },
    createVueShadowUi: vi.fn(),
    createModalDialogHostController: vi.fn(),
    shouldStartAreaTranslationFromHotkey: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.createVueShadowUi}));
vi.mock('@/src/features/area-translation/content/areaHotkey', () => ({
    shouldStartAreaTranslationFromHotkey: mocks.shouldStartAreaTranslationFromHotkey,
}));
vi.mock('@/src/features/selection-translation/content/modalDialogHost', () => ({
    createModalDialogHostController: mocks.createModalDialogHostController,
}));
vi.mock('@/src/features/selection-translation/ui/SelectionTranslator.vue', () => ({default: {name: 'SelectionTranslator'}}));
vi.mock('@/src/features/area-translation/ui/AreaTranslator.vue', () => ({default: {name: 'AreaTranslator'}}));

interface MockUi {
    mounted?: {app?: unknown; instance?: unknown};
    remove: ReturnType<typeof vi.fn>;
}

function ui(instance: unknown = {feature: 'mounted'}): MockUi {
    return {
        mounted: {app: {unmount: vi.fn()}, instance},
        remove: vi.fn(),
    };
}

function pendingUi(): {
    promise: Promise<MockUi>;
    resolve: (value: MockUi) => void;
} {
    let resolve!: (value: MockUi) => void;
    return {
        promise: new Promise<MockUi>((done) => {
            resolve = done;
        }),
        resolve,
    };
}

beforeEach(() => {
    vi.resetModules();
    mocks.createVueShadowUi.mockReset();
    mocks.createModalDialogHostController.mockReset();
    mocks.shouldStartAreaTranslationFromHotkey.mockReset();
    mocks.config.harness = undefined;
    mocks.config.disableSelectionTranslator = false;
    mocks.config.selectionTranslatorMode = 'bilingual';
    mocks.config.selectionAreaEnabled = true;
    mocks.config.on = true;
    vi.stubGlobal('document', Object.assign(new EventTarget(), {getElementById: vi.fn(() => null)}));
});

describe('划词翻译挂载生命周期', () => {
    it('先让当前实例复核来源，再恢复被移除或替换 body 的 host，卸载后不再复活', async () => {
        const {document, window} = parseHTML('<html><body><p>Original article</p></body></html>');
        const host = document.createElement('fluent-read-selection-translator-ui');
        document.body.appendChild(host);
        vi.stubGlobal('MutationObserver', window.MutationObserver);
        const source = document.querySelector('p')!;
        const sourceChecks: Array<{sourceConnected: boolean; hostConnected: boolean}> = [];
        const revalidateSource = vi.fn(() => {
            sourceChecks.push({sourceConnected: source.isConnected, hostConnected: host.isConnected});
        });
        const instance = {revalidateSource};
        const mountedUi = {...ui(instance), shadowHost: host};
        mountedUi.remove.mockImplementation(() => host.remove());
        mocks.createVueShadowUi.mockResolvedValueOnce(mountedUi);
        mocks.createModalDialogHostController.mockReturnValue({placeForRange: vi.fn(), dispose: vi.fn()});
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        try {
            expect(await runtime.mountSelectionTranslator({} as never)).toBe(instance);
            expect(revalidateSource).not.toHaveBeenCalled();
            host.remove();
            await vi.waitFor(() => expect(host.isConnected).toBe(true));
            expect(host.parentNode).toBe(document.body);
            // 来源仍有效时也必须询问当前组件 owner，且在重新接入页面之前执行。
            expect(sourceChecks).toEqual([{sourceConnected: true, hostConnected: false}]);
            const replacement = document.createElement('body');
            replacement.innerHTML = '<p>Next article</p>';
            document.body.replaceWith(replacement);
            await vi.waitFor(() => expect(host.parentNode).toBe(replacement));
            expect(sourceChecks).toEqual([
                {sourceConnected: true, hostConnected: false},
                {sourceConnected: false, hostConnected: false},
            ]);
            expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
            expect(mountedUi.remove).not.toHaveBeenCalled();
            runtime.unmountSelectionTranslator();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(host.isConnected).toBe(false);
            expect(mountedUi.remove).toHaveBeenCalledOnce();
            expect(revalidateSource).toHaveBeenCalledTimes(2);
        } finally {
            runtime.unmountSelectionTranslator();
            vi.unstubAllGlobals();
        }
    });

    it('持续删除只自动恢复两次，新选区允许恢复，禁用或上下文失效后停止恢复', async () => {
        const {document, window} = parseHTML('<html><body><p>Selected text</p></body></html>');
        const host = document.createElement('fluent-read-selection-translator-ui');
        document.body.appendChild(host);
        vi.stubGlobal('MutationObserver', window.MutationObserver);
        const context = {isInvalid: false};
        mocks.createVueShadowUi.mockResolvedValueOnce({...ui(), shadowHost: host});
        mocks.createModalDialogHostController.mockReturnValue({placeForRange: vi.fn(), dispose: vi.fn()});
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        try {
            await runtime.mountSelectionTranslator(context as never);
            for (let attempt = 0; attempt < 2; attempt++) {
                host.remove();
                await vi.waitFor(() => expect(host.isConnected).toBe(true));
            }
            host.remove();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(host.isConnected).toBe(false);
            const reportRange = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
            reportRange({startContainer: document.querySelector('p'), endContainer: document.querySelector('p')});
            expect(host.isConnected).toBe(true);
            mocks.config.disableSelectionTranslator = true;
            host.remove();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(host.isConnected).toBe(false);
            mocks.config.disableSelectionTranslator = false;
            context.isInvalid = true;
            reportRange({startContainer: document.querySelector('p'), endContainer: document.querySelector('p')});
            expect(host.isConnected).toBe(false);
            expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
        } finally {
            runtime.unmountSelectionTranslator();
            vi.unstubAllGlobals();
        }
    });

    it('body 暂时缺失时恢复到文档根，观察范围只包含自有 host 祖先的直接子节点', async () => {
        const {document, window} = parseHTML('<html><head></head><body></body></html>');
        const host = document.createElement('fluent-read-selection-translator-ui');
        document.body.appendChild(host);
        const observations: Array<{target: Node; options: MutationObserverInit}> = [];
        class TrackedObserver extends window.MutationObserver {
            observe(target: Node, options: MutationObserverInit) {
                observations.push({target, options: {...options}});
                super.observe(target, options);
            }
        }
        vi.stubGlobal('MutationObserver', TrackedObserver);
        mocks.createVueShadowUi.mockResolvedValueOnce({...ui(), shadowHost: host});
        mocks.createModalDialogHostController.mockReturnValue({placeForRange: vi.fn(), dispose: vi.fn()});
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        try {
            await runtime.mountSelectionTranslator({} as never);
            // 浏览器可在 body 被替换的同步步骤之间暂时读到 null；用 getter 保留这一原生边界。
            const oldBody = document.body;
            Object.defineProperty(document, 'body', {configurable: true, get: () => null});
            oldBody.remove();
            await vi.waitFor(() => expect(host.parentNode).toBe(document.documentElement));
            expect(observations.every(({options}) => JSON.stringify(options) === '{"childList":true}')).toBe(true);
            expect(observations.map(({target}) => target)).not.toContain(host);
            document.documentElement.remove();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(host.isConnected).toBe(false);
            const newRoot = document.createElement('html');
            document.appendChild(newRoot);
            await vi.waitFor(() => expect(host.parentNode).toBe(newRoot));
        } finally {
            runtime.unmountSelectionTranslator();
            vi.unstubAllGlobals();
        }
    });

    it('选区仅转发给当前 host，卸载先恢复 modal 所有权再移除界面', async () => {
        const pending = pendingUi();
        const shadowHost = {style: {setProperty: vi.fn()}};
        const controller = {placeForRange: vi.fn(), dispose: vi.fn()};
        const mountedUi = {...ui(), shadowHost};
        mocks.createModalDialogHostController.mockReturnValue(controller);
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const request = runtime.mountSelectionTranslator({} as never);
        const reportRange = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
        const range = {startContainer: {nodeType: 3}};

        reportRange(range);
        expect(controller.placeForRange).not.toHaveBeenCalled();
        pending.resolve(mountedUi);
        await request;
        expect(shadowHost.style.setProperty).toHaveBeenCalledWith('position', 'static', 'important');
        expect(mocks.createModalDialogHostController).toHaveBeenCalledWith(shadowHost);
        reportRange(range);
        reportRange(null);
        expect(controller.placeForRange.mock.calls).toEqual([[range], [null]]);

        runtime.unmountSelectionTranslator();
        expect(controller.dispose).toHaveBeenCalledOnce();
        expect(controller.dispose.mock.invocationCallOrder[0]).toBeLessThan(mountedUi.remove.mock.invocationCallOrder[0]);
        reportRange(range);
        expect(controller.placeForRange).toHaveBeenCalledTimes(2);
    });

    it('不完整挂载句柄缺少 host 样式时仍可安全卸载', async () => {
        const mountedUi = {...ui(), shadowHost: {}};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        await runtime.mountSelectionTranslator({} as never);
        expect(mocks.createModalDialogHostController).not.toHaveBeenCalled();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('划词总开关关闭时 Harness 不单独挂载，重新启用后关闭会丢弃待挂载 UI', async () => {
        mocks.config.harness = {enabled: true};
        mocks.config.disableSelectionTranslator = true;
        mocks.config.selectionTranslatorMode = 'disabled';
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const mounted = ui();
        mocks.createVueShadowUi.mockResolvedValueOnce(mounted);
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'bilingual';
        await expect(runtime.mountSelectionTranslator({} as never)).resolves.toEqual({feature: 'mounted'});
        runtime.unmountSelectionTranslator();
        const pending = pendingUi();
        const late = ui();
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise);
        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config.harness.enabled = false;
        mocks.config.disableSelectionTranslator = true;
        mocks.config.selectionTranslatorMode = 'disabled';
        pending.resolve(late);
        await expect(request).resolves.toBeNull();
        expect(late.remove).toHaveBeenCalledOnce();
    });

    it('启用划词的 Harness 共享实例重挂载后，旧组件 Range 回调不得移动新 modal host', async () => {
        mocks.config.harness = {enabled: true};
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'bilingual';
        const firstHost = {style: {setProperty: vi.fn()}};
        const secondHost = {style: {setProperty: vi.fn()}};
        const firstController = {placeForRange: vi.fn(), dispose: vi.fn()};
        const secondController = {placeForRange: vi.fn(), dispose: vi.fn()};
        const firstUi = {...ui(), shadowHost: firstHost};
        const secondUi = {...ui(), shadowHost: secondHost};
        mocks.createVueShadowUi.mockResolvedValueOnce(firstUi).mockResolvedValueOnce(secondUi);
        mocks.createModalDialogHostController.mockReturnValueOnce(firstController).mockReturnValueOnce(secondController);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        await runtime.mountSelectionTranslator({} as never);
        const firstReport = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
        const range = {startContainer: {nodeType: 3}};
        firstReport(range);
        expect(firstController.placeForRange).toHaveBeenCalledWith(range);
        runtime.unmountSelectionTranslator();
        expect(firstController.dispose.mock.invocationCallOrder[0]).toBeLessThan(firstUi.remove.mock.invocationCallOrder[0]);

        await runtime.mountSelectionTranslator();
        const secondReport = mocks.createVueShadowUi.mock.calls[1][1].props.onSelectionRangeChange;
        firstReport(range);
        firstReport(null);
        expect(secondController.placeForRange).not.toHaveBeenCalled();
        secondReport(range);
        secondReport(null);
        expect(secondController.placeForRange.mock.calls).toEqual([[range], [null]]);
        runtime.unmountSelectionTranslator();
        expect(secondController.dispose.mock.invocationCallOrder[0]).toBeLessThan(secondUi.remove.mock.invocationCallOrder[0]);
    });

    it('没有内容脚本上下文或功能关闭时不挂载', async () => {
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        expect(runtime.mountSelectionTranslator()).toBeUndefined();
        mocks.config.disableSelectionTranslator = true;
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'disabled';
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    });

    it('只创建一个关闭 Shadow DOM，并在卸载时清理', async () => {
        const mountedUi = ui();
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const context = {name: 'content'} as never;

        await expect(runtime.mountSelectionTranslator(context)).resolves.toEqual({feature: 'mounted'});
        expect(mocks.createVueShadowUi).toHaveBeenCalledWith(context, expect.objectContaining({
            name: 'fluent-read-selection-translator-ui',
            hostId: 'fluent-read-selection-translator-container',
            zIndex: 2_147_483_646,
            mode: 'closed',
        }));
        expect(runtime.mountSelectionTranslator()).toBeNull();

        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('复用正在挂载的请求，并丢弃卸载后的迟到结果', async () => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        const request = runtime.mountSelectionTranslator({} as never);
        expect(runtime.mountSelectionTranslator()).toBe(request);
        runtime.unmountSelectionTranslator();
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it.each([
        ['disableSelectionTranslator', true],
        ['selectionTranslatorMode', 'disabled'],
    ] as const)('挂载期间配置字段 %s 关闭时移除迟到界面', async (key, value) => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config[key] = value as never;
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('没有 Vue 实例的挂载句柄仍可恢复自有 host，卸载后停止恢复', async () => {
        const {document, window} = parseHTML('<html><body></body></html>');
        const host = document.createElement('fluent-read-selection-translator-ui');
        document.body.appendChild(host);
        vi.stubGlobal('MutationObserver', window.MutationObserver);
        const mountedUi = {remove: vi.fn(() => host.remove()), shadowHost: host};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        mocks.createModalDialogHostController.mockReturnValue({placeForRange: vi.fn(), dispose: vi.fn()});
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        try {
            await expect(runtime.mountSelectionTranslator({} as never)).resolves.toBeNull();
            host.remove();
            await vi.waitFor(() => expect(host.isConnected).toBe(true));
            expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
            runtime.unmountSelectionTranslator();
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(host.isConnected).toBe(false);
            expect(mountedUi.remove).toHaveBeenCalledOnce();
        } finally {
            runtime.unmountSelectionTranslator();
            vi.unstubAllGlobals();
        }
    });
});

describe('圈选翻译按需挂载生命周期', () => {
    it('shares an unfinished UI mount across simultaneous context menu activations', async () => {
        const pending = pendingUi(), beginSelection = vi.fn(() => true);
        const mountedUi = ui({beginSelection});
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise);
        const runtime = await import('@/src/features/area-translation/public');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');
        runtime.mountAreaTranslator({} as never);
        const first = startAreaTranslationFromContextMenu(), second = startAreaTranslationFromContextMenu();
        expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
        pending.resolve(mountedUi);
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(beginSelection).toHaveBeenCalledTimes(2);
        runtime.unmountAreaTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });
    it('reports a rejected lazy mount once and permits a later shortcut to retry', async () => {
        const failure=new Error('shadow UI creation failed'),error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
        const beginSelection=vi.fn(()=>true);mocks.createVueShadowUi.mockRejectedValueOnce(failure).mockResolvedValueOnce(ui({beginSelection}));
        const listen=vi.spyOn(document,'addEventListener'),runtime=await import('@/src/features/area-translation/public');
        try {
            runtime.mountAreaTranslator({} as never);const key=listen.mock.calls.find(([type])=>type==='keydown')![1] as (event:KeyboardEvent)=>void;
            mocks.shouldStartAreaTranslationFromHotkey.mockReturnValue(true);const event={preventDefault:vi.fn()} as unknown as KeyboardEvent;
            key(event);await vi.waitFor(()=>expect(error).toHaveBeenCalledWith('[FluentRead] 圈选翻译挂载失败',failure));
            key(event);await vi.waitFor(()=>expect(beginSelection).toHaveBeenCalledOnce());expect(mocks.createVueShadowUi).toHaveBeenCalledTimes(2);
        } finally {runtime.unmountAreaTranslator();error.mockRestore();listen.mockRestore();}
    });
    it('可信快捷键由入口启动覆盖层，未匹配手势不创建 UI', async () => {
        const beginSelection = vi.fn().mockReturnValue(true);
        mocks.createVueShadowUi.mockResolvedValue(ui({beginSelection}));
        const addEventListener = vi.spyOn(document, 'addEventListener');
        const runtime = await import('@/src/features/area-translation/public');
        runtime.mountAreaTranslator({} as never);
        const onKeydown = addEventListener.mock.calls.find(([type]) => type === 'keydown')?.[1] as (event: KeyboardEvent) => void;
        const event = {preventDefault: vi.fn()} as unknown as KeyboardEvent;

        mocks.shouldStartAreaTranslationFromHotkey.mockReturnValueOnce(false).mockReturnValueOnce(true);
        onKeydown(event);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        onKeydown(event);
        await vi.waitFor(() => expect(beginSelection).toHaveBeenCalledOnce());
        expect(event.preventDefault).toHaveBeenCalledOnce();
        runtime.unmountAreaTranslator();
        // 已排队的旧事件回调即使迟到，也不得重新创建覆盖层。
        mocks.shouldStartAreaTranslationFromHotkey.mockReturnValueOnce(true);
        onKeydown(event);
        expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    });
    it('空闲页面只注册入口，不创建 Shadow DOM；卸载时清除入口', async () => {
        const runtime = await import('@/src/features/area-translation/public');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        runtime.mountAreaTranslator({} as never);
        expect(runtime.isAreaTranslatorMounted()).toBe(true);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        runtime.unmountAreaTranslator();
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        expect(startAreaTranslationFromContextMenu()).toBe(false);
    });

    it('没有上下文、总开关关闭或圈选关闭时不注册入口', async () => {
        const runtime = await import('@/src/features/area-translation/public');

        expect(runtime.mountAreaTranslator()).toBeUndefined();
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        mocks.config.selectionAreaEnabled = false;
        runtime.mountAreaTranslator({} as never);
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        mocks.config.selectionAreaEnabled = true;
        mocks.config.on = false;
        runtime.mountAreaTranslator({} as never);
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    });

    it('首次右键命令才创建 closed Shadow DOM，后续命令复用当前实例', async () => {
        const beginSelection = vi.fn().mockReturnValue(true);
        const mountedUi = ui({beginSelection});
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/area-translation/public');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');
        const context = {name: 'content'} as never;

        runtime.mountAreaTranslator(context);
        runtime.mountAreaTranslator(context);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(true);
        expect(beginSelection).toHaveBeenCalledOnce();
        expect(mocks.createVueShadowUi).toHaveBeenNthCalledWith(1, context, expect.objectContaining({
            name: 'fluent-read-area-translator-ui',
            hostId: 'fluent-read-area-translator-container',
            zIndex: 2_147_483_647,
            mode: 'closed',
        }));
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(true);
        expect(beginSelection).toHaveBeenCalledTimes(2);
        expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();

        runtime.unmountAreaTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('卸载时丢弃迟到 UI，并允许下一次入口重新挂载', async () => {
        const pending = pendingUi();
        const staleUi = ui({beginSelection: vi.fn().mockReturnValue(true)});
        const nextBegin = vi.fn().mockReturnValue(true);
        const nextUi = ui({beginSelection: nextBegin});
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(nextUi);
        const runtime = await import('@/src/features/area-translation/public');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        runtime.mountAreaTranslator({} as never);
        const activation = startAreaTranslationFromContextMenu();
        runtime.unmountAreaTranslator();
        pending.resolve(staleUi);
        await expect(activation).resolves.toBe(false);
        expect(staleUi.remove).toHaveBeenCalledOnce();
        expect(startAreaTranslationFromContextMenu()).toBe(false);

        runtime.mountAreaTranslator({} as never);
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(true);
        expect(nextBegin).toHaveBeenCalledOnce();
        runtime.unmountAreaTranslator();
    });

    it('挂载期间被关闭时移除迟到界面', async () => {
        const pending = pendingUi();
        const mountedUi = ui({beginSelection: vi.fn().mockReturnValue(true)});
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/area-translation/public');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        runtime.mountAreaTranslator({} as never);
        const activation = startAreaTranslationFromContextMenu();
        mocks.config.selectionAreaEnabled = false;
        pending.resolve(mountedUi);

        await expect(activation).resolves.toBe(false);
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        expect(startAreaTranslationFromContextMenu()).toBe(false);
        runtime.unmountAreaTranslator();
    });

    it('挂载器返回没有可启动实例时清除空 UI', async () => {
        const mountedUi = {remove: vi.fn()};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/area-translation/public');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        runtime.mountAreaTranslator({} as never);
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(false);
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        runtime.unmountAreaTranslator();
    });
});


describe('focused selection dismissal runtime ownership', () => {
    afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

    function focusDom() {
        const window = parseHTML('<html><body><div id="origin"><div id="first-host"></div><div id="second-host"></div></div><dialog><button>Native control</button><p>Selected text</p></dialog></body></html>');
        const document = window.document;
        const origin = document.querySelector('#origin') as HTMLElement;
        const firstHost = document.querySelector('#first-host') as HTMLElement;
        const secondHost = document.querySelector('#second-host') as HTMLElement;
        const dialog = document.querySelector('dialog') as HTMLDialogElement;
        const native = dialog.querySelector('button') as HTMLElement;
        const selected = dialog.querySelector('p')!.firstChild!;
        let active: Element | null = native;
        Object.defineProperties(document, {activeElement: {configurable: true, get: () => active},
            hasFocus: {configurable: true, value: () => true}});
        dialog.open = true;
        Object.defineProperty(dialog, 'matches', {configurable: true, value: (selector: string) => selector === ':modal'});
        for (const element of [native, dialog]) {
            Object.defineProperty(element, 'getClientRects', {configurable: true,
                value: () => [{left: 0, top: 0, width: 80, height: 24}]});
        }
        const nativeFocus = vi.fn(() => {active = native;});
        Object.defineProperty(native, 'focus', {configurable: true, value: nativeFocus});
        Object.defineProperty(dialog, 'focus', {configurable: true, value: vi.fn(() => {active = dialog;})});
        window.getComputedStyle = (() => ({transform: 'none', display: 'block', visibility: 'visible'})) as unknown as typeof window.getComputedStyle;
        const frames = new Map<number, FrameRequestCallback>();
        let frame = 0;
        window.requestAnimationFrame = callback => {frames.set(++frame, callback); return frame;};
        window.cancelAnimationFrame = id => {frames.delete(id);};
        class QuietResizeObserver {observe() {} disconnect() {}}
        vi.stubGlobal('document', document);
        vi.stubGlobal('Node', window.Node);
        vi.stubGlobal('MutationObserver', window.MutationObserver);
        vi.stubGlobal('ResizeObserver', QuietResizeObserver);
        const append = origin.appendChild.bind(origin), insert = origin.insertBefore.bind(origin);
        const moved = (node: Node) => {if (node === active) active = document.body;};
        vi.spyOn(origin, 'appendChild').mockImplementation(node => {const result = append(node); moved(node); return result;});
        vi.spyOn(origin, 'insertBefore').mockImplementation((node, before) => {const result = insert(node, before); moved(node); return result;});
        return {document, origin, firstHost, secondHost, dialog, native, nativeFocus,
            range: {startContainer: selected, endContainer: selected} as unknown as Range,
            setActive: (element: Element | null) => {active = element;}};
    }

    it('repairs a removed modal host in its existing slot and restores it when the dialog disappears', async () => {
        const dom = focusDom();
        const actual = await vi.importActual<typeof import('@/src/features/selection-translation/content/modalDialogHost')>(
            '@/src/features/selection-translation/content/modalDialogHost');
        mocks.createModalDialogHostController.mockImplementation(actual.createModalDialogHostController);
        mocks.createVueShadowUi.mockResolvedValueOnce({...ui(), shadowHost: dom.firstHost});
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        try {
            await runtime.mountSelectionTranslator({} as never);
            mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange(dom.range);
            const slot = dom.firstHost.parentNode;
            dom.firstHost.remove();
            await vi.waitFor(() => expect(dom.firstHost.parentNode).toBe(slot));
            expect(slot?.parentNode).toBe(dom.dialog);
            dom.dialog.remove();
            await vi.waitFor(() => expect(dom.firstHost.parentNode).toBe(dom.origin));
            expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
            expect(dom.nativeFocus).not.toHaveBeenCalled();
        } finally {
            runtime.unmountSelectionTranslator();
        }
    });

    it('forwards dismissal only after the current actual modal controller exists', async () => {
        const dom = focusDom();
        const actual = await vi.importActual<typeof import('@/src/features/selection-translation/content/modalDialogHost')>(
            '@/src/features/selection-translation/content/modalDialogHost');
        mocks.createModalDialogHostController.mockImplementation(actual.createModalDialogHostController);
        const pending = pendingUi();
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const request = runtime.mountSelectionTranslator({} as never);
        const props = mocks.createVueShadowUi.mock.calls[0][1].props;
        props.onFocusedCardDismiss();
        expect(mocks.createModalDialogHostController).not.toHaveBeenCalled();
        expect(dom.nativeFocus).not.toHaveBeenCalled();

        pending.resolve({...ui(), shadowHost: dom.firstHost} as MockUi);
        await request;
        props.onSelectionRangeChange(dom.range);
        const slot = dom.firstHost.parentElement!;
        expect(slot.parentElement).toBe(dom.dialog);
        dom.setActive(dom.firstHost);
        props.onFocusedCardDismiss();

        expect(dom.firstHost.parentElement).toBe(dom.origin);
        expect(slot.isConnected).toBe(false);
        expect(dom.nativeFocus).toHaveBeenCalledOnce();
        expect(dom.nativeFocus).toHaveBeenCalledWith({preventScroll: true});
        expect(dom.document.activeElement).toBe(dom.native);
        props.onSelectionRangeChange(null);
        runtime.unmountSelectionTranslator();
        props.onFocusedCardDismiss();
        expect(dom.nativeFocus).toHaveBeenCalledOnce();
    });

    it.each(['mounted', 'pending'] as const)('ignores a %s old generation dismissal after remount', async oldStage => {
        const dom = focusDom();
        const actual = await vi.importActual<typeof import('@/src/features/selection-translation/content/modalDialogHost')>(
            '@/src/features/selection-translation/content/modalDialogHost');
        mocks.createModalDialogHostController.mockImplementation(actual.createModalDialogHostController);
        const oldPending = pendingUi();
        const oldUi = {...ui(), shadowHost: dom.firstHost};
        mocks.createVueShadowUi.mockReturnValueOnce(oldPending.promise).mockResolvedValueOnce({...ui(), shadowHost: dom.secondHost});
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const oldRequest = runtime.mountSelectionTranslator({} as never);
        const oldProps = mocks.createVueShadowUi.mock.calls[0][1].props;
        if (oldStage === 'mounted') {
            oldPending.resolve(oldUi);
            await oldRequest;
            oldProps.onSelectionRangeChange(dom.range);
            dom.setActive(dom.firstHost);
        }
        runtime.unmountSelectionTranslator();
        dom.setActive(dom.native);
        await runtime.mountSelectionTranslator();
        const currentProps = mocks.createVueShadowUi.mock.calls[1][1].props;
        currentProps.onSelectionRangeChange(dom.range);
        const currentSlot = dom.secondHost.parentElement!;
        dom.setActive(dom.secondHost);
        if (oldStage === 'pending') {
            oldPending.resolve(oldUi);
            await expect(oldRequest).resolves.toBeNull();
            expect(oldUi.remove).toHaveBeenCalledOnce();
        }

        oldProps.onFocusedCardDismiss();
        expect(dom.secondHost.parentElement).toBe(currentSlot);
        expect(currentSlot.parentElement).toBe(dom.dialog);
        expect(dom.nativeFocus).not.toHaveBeenCalled();
        currentProps.onFocusedCardDismiss();
        expect(dom.secondHost.parentElement).toBe(dom.origin);
        expect(dom.nativeFocus).toHaveBeenCalledOnce();
        expect(dom.document.activeElement).toBe(dom.native);
        runtime.unmountSelectionTranslator();
        oldProps.onFocusedCardDismiss();
        currentProps.onFocusedCardDismiss();
        expect(dom.nativeFocus).toHaveBeenCalledOnce();
    });
});

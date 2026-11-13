// 图片后台公共 handler 默认时钟契约：只控制外部时钟和 provider 端口，不注入 dependencies.now。
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    createImageTranslationBackgroundHandlers,
    IMAGE_CANCEL_MESSAGE_TYPE,
    IMAGE_TRANSLATE_MESSAGE_TYPE,
    IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
    type ImageOperationOptions,
    type ImageTranslationBackgroundDependencies,
} from '@/src/features/image-translation/background/handlers';
import {getTranslationRequestControl} from '@/src/services/translation/requestSnapshot';
import {TRANSLATION_REMAINING_BUDGET, type TranslationRemainingBudgetContext} from '@/src/services/translation/types';

type ProviderRequest = Parameters<ImageTranslationBackgroundDependencies['translateTexts']>[0];
type Outcome = {ok: true; value: unknown} | {ok: false; error: unknown};
const texts = ['First sentence.', 'Second sentence.', 'Third sentence.', 'Fourth sentence.'];
const translations = ['译:first', '译:second', '译:third', '译:fourth'];
const wallStart = Date.UTC(2026, 9, 7);
let monotonicMs = 0;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    let settled = false;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    return {
        promise,
        get settled() { return settled; },
        resolve(value: T) { if (!settled) { settled = true; resolve(value); } },
        reject(error: unknown) { if (!settled) { settled = true; reject(error); } },
    };
}

function observe(pending: Promise<unknown>) {
    let outcome: Outcome | undefined;
    const promise = pending.then(
        value => (outcome = {ok: true, value} as const),
        error => (outcome = {ok: false, error} as const),
    );
    return {promise, get outcome() { return outcome; }};
}

// 固定轮数只排空公共入口的 Promise 链，不推进超时或替 handler 计算预算。
async function flushMicrotasks() {
    for (let index = 0; index < 16; index++) await Promise.resolve();
}

function fixture() {
    const calls: Array<{request: ProviderRequest; gate: ReturnType<typeof deferred<string | string[]>>}> = [];
    const images: Array<{options: ImageOperationOptions; gate: ReturnType<typeof deferred<unknown>>}> = [];
    const owned: ReturnType<typeof observe>[] = [];
    const requestIds = new Set<string>();
    const dependencies: ImageTranslationBackgroundDependencies = {
        assertLanguagesDownloaded: vi.fn(async () => undefined),
        translateImage: vi.fn((...args: Parameters<ImageTranslationBackgroundDependencies['translateImage']>) => {
            const options = args[3];
            const gate = deferred<unknown>();
            images.push({options, gate});
            return gate.promise;
        }),
        fetchImage: vi.fn(async () => 'data:image/png;base64,external'),
        translateTexts: vi.fn((request: ProviderRequest) => {
            const gate = deferred<string | string[]>();
            calls.push({request, gate});
            return gate.promise;
        }),
        getTranslationService: () => 'google',
        supportsBatchTranslation: () => false,
        downloadLanguages: vi.fn(async () => undefined),
        markLanguagesDownloaded: vi.fn(async () => []),
    };
    const handlers = createImageTranslationBackgroundHandlers(dependencies);
    const textHandler = handlers.find(handler => handler.type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;
    const imageHandler = handlers.find(handler => handler.type === IMAGE_TRANSLATE_MESSAGE_TYPE)!;
    const cancelHandler = handlers.find(handler => handler.type === IMAGE_CANCEL_MESSAGE_TYPE)!;
    const cancel = (requestId: string) => cancelHandler.handle({type: IMAGE_CANCEL_MESSAGE_TYPE, requestId});
    const own = (requestId: string, pending: Promise<unknown>) => {
        requestIds.add(requestId);
        const result = observe(pending);
        owned.push(result);
        return result;
    };
    return {
        calls, images, dependencies,
        start(requestId: string) {
            return own(requestId, textHandler.handle({
                type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, requestId, texts: [...texts],
                title: 'Clock fixture', timeoutMs: 1_000,
            }));
        },
        startImage(requestId: string) {
            return own(requestId, imageHandler.handle({
                type: IMAGE_TRANSLATE_MESSAGE_TYPE, requestId, image: 'data:image/png;base64,external',
                sourceLanguage: 'eng', title: 'Clock fixture', timeoutMs: 1_000,
            }));
        },
        cancel,
        async dispose() {
            // 只停止本 fixture 的公共 requestId，然后结清已交给真实 handler 的外部端口。
            for (const requestId of requestIds) await cancel(requestId);
            for (const call of calls) call.gate.reject(new Error('fixture text teardown'));
            for (const image of images) image.gate.reject(new Error('fixture image teardown'));
            await Promise.all(owned.map(result => result.promise));
            await flushMicrotasks();
            expect(calls.every(call => call.gate.settled)).toBe(true);
            expect(images.every(image => image.gate.settled)).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        },
    };
}

const fixtures: ReturnType<typeof fixture>[] = [];
function createFixture() {
    const current = fixture();
    fixtures.push(current);
    expect('now' in current.dependencies).toBe(false);
    return current;
}

function assertControls(current: ReturnType<typeof fixture>, requestId: string, aborted = false) {
    const controls = current.calls.map(({request}) => {
        expect((request as ProviderRequest & TranslationRemainingBudgetContext)[TRANSLATION_REMAINING_BUDGET]).toBe(true);
        expect(request).toMatchObject({context: expect.stringContaining('Clock fixture'), pageContext: '', useCache: true, serviceOverride: 'google'});
        const control = getTranslationRequestControl(request);
        expect(control?.ownershipKey).toBe(`image:${requestId}`);
        expect(control?.signal.aborted).toBe(aborted);
        return control!;
    });
    expect(new Set(controls.map(control => control.signal)).size).toBe(1);
}

beforeEach(() => {
    // Date 和定时器独立于 performance；两个外部时钟都不会作为依赖函数传入生产代码。
    vi.useFakeTimers({toFake: ['Date', 'setTimeout', 'clearTimeout']});
    vi.setSystemTime(wallStart);
    monotonicMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
});

afterEach(async () => {
    try {
        for (const current of fixtures.splice(0)) await current.dispose();
    } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
    }
});

describe('图片后台默认 monotonic 剩余预算', () => {
    it.each([
        {wallJump: 300_000, elapsed: 0},
        {wallJump: 300_000, elapsed: 20},
        {wallJump: -300_000, elapsed: 0},
        {wallJump: -300_000, elapsed: 20},
    ])('20ms 后墙钟 $wallJump ms、monotonic $elapsed ms：三 worker 四段保序且预算不扩大', async ({wallJump, elapsed}) => {
        const current = createFixture();
        const requestId = `clock-${wallJump}-${elapsed}`;
        const result = current.start(requestId);
        await flushMicrotasks();
        expect(current.calls.map(call => call.request.origin)).toEqual(texts.slice(0, 3));
        expect(current.calls.map(call => call.request.requestTimeoutMs)).toEqual([1_000, 1_000, 1_000]);
        expect(current.calls.filter(call => !call.gate.settled)).toHaveLength(3);
        assertControls(current, requestId);

        await vi.advanceTimersByTimeAsync(20);
        monotonicMs = elapsed;
        vi.setSystemTime(Date.now() + wallJump);
        expect(Date.now()).toBe(wallStart + 20 + wallJump);
        expect(performance.now()).toBe(elapsed);
        current.calls[0].gate.resolve(translations[0]);
        await flushMicrotasks();

        expect(current.calls.map(call => call.request.origin)).toEqual(texts);
        expect(current.calls.filter(call => !call.gate.settled)).toHaveLength(3);
        expect(current.calls[3].request.requestTimeoutMs).toBe(1_000 - elapsed);
        expect(current.calls.every(call => call.request.requestTimeoutMs > 0 && call.request.requestTimeoutMs <= 1_000)).toBe(true);
        assertControls(current, requestId);
        expect(result.outcome).toBeUndefined();

        // provider 故意乱序完成，handler 仍必须按原 OCR 行返回。
        current.calls[2].gate.resolve(translations[2]);
        current.calls[3].gate.resolve(translations[3]);
        await flushMicrotasks();
        expect(result.outcome).toBeUndefined();
        current.calls[1].gate.resolve(translations[1]);
        expect(await result.promise).toEqual({ok: true, value: {success: true, translations}});
        expect(current.calls).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('公共 cancel 同时停止同 ID 的图片与三个文本 worker，迟到拒绝不替换取消结果', async () => {
        const current = createFixture();
        const requestId = 'shared-image-text-cancel';
        const text = current.start(requestId);
        const image = current.startImage(requestId);
        await flushMicrotasks();
        expect(current.calls).toHaveLength(3);
        expect(current.images).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(2);
        assertControls(current, requestId);
        expect(current.images[0].options).toMatchObject({requestId, timeoutMs: 1_000});
        expect(current.images[0].options.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(20);
        monotonicMs = 20;
        vi.setSystemTime(Date.now() + 300_000);

        expect(await current.cancel(requestId)).toEqual({success: true, cancelled: true, requestId});
        const textOutcome = await text.promise;
        const imageOutcome = await image.promise;
        expect(textOutcome).toMatchObject({ok: false, error: {name: 'AbortError', message: '图片 OCR 请求已取消'}});
        expect(imageOutcome).toMatchObject({ok: false, error: {name: 'AbortError', message: '图片 OCR 请求已取消'}});
        assertControls(current, requestId, true);
        expect(current.images[0].options.signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        current.calls.forEach((call, index) => call.gate.reject(new Error(`late text ${index}`)));
        current.images[0].gate.reject(new Error('late image'));
        await flushMicrotasks();
        expect(text.outcome).toBe(textOutcome);
        expect(image.outcome).toBe(imageOutcome);
        expect(current.calls).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('首个 provider 错误保留段号和主错误，共享 abort 后迟到错误不启动第四段', async () => {
        const current = createFixture();
        const requestId = 'provider-primary-failure';
        const result = current.start(requestId);
        await flushMicrotasks();
        expect(current.calls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(20);
        monotonicMs = 20;
        vi.setSystemTime(Date.now() - 300_000);
        current.calls[1].gate.reject(new Error('primary provider failure'));
        const outcome = await result.promise;
        expect(outcome).toMatchObject({ok: false, error: {message: '图片第 2 段文字翻译失败：primary provider failure'}});
        assertControls(current, requestId, true);
        current.calls[0].gate.reject(new Error('late first failure'));
        current.calls[2].gate.reject(new Error('late third failure'));
        await flushMicrotasks();
        expect(result.outcome).toBe(outcome);
        expect(current.calls).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('墙钟回退不重置 1000ms 外层超时，20ms 后仍只等待原剩余 980ms 再 abort', async () => {
        const current = createFixture();
        const requestId = 'original-timer-deadline';
        const result = current.start(requestId);
        await flushMicrotasks();
        expect(current.calls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(20);
        monotonicMs = 20;
        vi.setSystemTime(Date.now() - 300_000);
        current.calls[0].gate.resolve(translations[0]);
        await flushMicrotasks();
        expect(current.calls).toHaveLength(4);
        monotonicMs = 999;
        await vi.advanceTimersByTimeAsync(979);
        expect(result.outcome).toBeUndefined();
        expect(vi.getTimerCount()).toBe(1);
        monotonicMs = 1_000;
        await vi.advanceTimersByTimeAsync(1);
        const outcome = await result.promise;
        expect(outcome).toMatchObject({ok: false, error: {name: 'TimeoutError', message: '图片 OCR 请求超时'}});
        assertControls(current, requestId, true);
        current.calls.slice(1).forEach((call, index) => call.gate.reject(new Error(`late timeout ${index}`)));
        await flushMicrotasks();
        expect(result.outcome).toBe(outcome);
        expect(current.calls).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(0);
    });
});

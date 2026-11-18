/**
 * @file src/app/offscreen/translation.ts
 * 文件职责：在离屏文档中调用 Chrome 和 Edge 的浏览器内置翻译，处理模型状态、语言检测、规范化与错误。
 * 主要内容：定义最小环境与请求契约，验证语言码并映射中文别名；现代 API 按环境复用一个检测器和最多两个语言对，以独立取消、串行租约、空闲 TTL 与 LRU 控制常驻，旧 API 保持独占清理；保留 availability、下载进度、低置信度和保守脚本兜底。
 * 模块边界：这里不读取扩展配置、不选择第三方 provider，也不监听 runtime 消息；调用协议由 offscreen/messageRouter 管理，宿主能力是否开放由 browser capability 层决定。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {detectChineseScript, MIN_CHROME_LANGUAGE_CONFIDENCE} from '@/src/core/language/detect';
import {hasBrowserTranslationApi} from '@/src/platform/browser/capabilities';
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';

// 保留既有导出，同时让设置页与 offscreen 共用单一阈值。
export {MIN_CHROME_LANGUAGE_CONFIDENCE} from '@/src/core/language/detect';

/** 浏览器内置翻译在离屏文档中暴露的最小能力。 */
export interface ChromeTranslationEnvironment {
    readonly translation?: {
        createDetector?: () => Promise<ChromeLanguageDetector>;
        createTranslator?: (options: ChromeTranslatorOptions) => Promise<ChromeTranslator>;
    };
    readonly LanguageDetector?: {
        availability?: () => Promise<unknown>;
        create: (options?: ChromeModelCreateOptions) => Promise<ChromeLanguageDetector>;
    };
    readonly Translator?: {
        availability?: (options: ChromeTranslatorOptions) => Promise<unknown>;
        create: (options: ChromeTranslatorOptions & ChromeModelCreateOptions) => Promise<ChromeTranslator>;
    };
}

interface ChromeLanguageDetector {
    detect(text: string, options?: ChromeOperationOptions): Promise<unknown>;
    destroy?: () => void;
}

interface ChromeTranslatorOptions {
    sourceLanguage: string;
    targetLanguage: string;
}

interface ChromeTranslator {
    translate?: (text: string, options?: ChromeOperationOptions) => Promise<unknown>;
    translateStreaming?: (text: string, options?: ChromeOperationOptions) => AsyncIterable<unknown>;
    destroy?: () => void;
}

interface ChromeOperationOptions {
    signal?: AbortSignal;
}

interface ChromeDownloadProgressEvent {
    loaded?: unknown;
}

interface ChromeModelMonitor {
    addEventListener(type: 'downloadprogress', listener: (event: ChromeDownloadProgressEvent) => void): void;
}

interface ChromeModelCreateOptions extends ChromeOperationOptions {
    monitor?: (monitor: ChromeModelMonitor) => void;
}

export type ChromeModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
export type ChromeModelKind = 'language-detector' | 'translator';
export type ChromeModelPhase = 'checking' | 'downloading' | 'initializing' | 'ready';

export interface ChromeModelStatus {
    readonly model: ChromeModelKind;
    readonly phase: ChromeModelPhase;
    readonly availability?: ChromeModelAvailability;
    readonly loaded?: number;
}

export type ChromeModelStatusReporter = (status: ChromeModelStatus) => void;

export interface ChromeTranslationRequest {
    text: string;
    from: string;
    to: string;
    sourceLanguageDetectionText?: string;
}

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;
const CHROME_MODEL_AVAILABILITIES = new Set<ChromeModelAvailability>([
    'unavailable',
    'downloadable',
    'downloading',
    'available',
]);
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析跨进程翻译请求。协议错误在进入浏览器实验 API 前即失败，避免把
 * `null`、对象或 `to=auto` 交给底层后得到难以定位的 DOMException。
 */
export function parseChromeTranslationRequest(value: unknown): ChromeTranslationRequest {
    if (!isRecord(value)) throw new TypeError('Chrome 翻译请求 data 必须是对象');
    const text = value.text;
    if (typeof text !== 'string') throw new TypeError('Chrome 翻译文本必须是字符串');
    const from = parseLanguageCode(value.from, 'from', true);
    const to = parseLanguageCode(value.to, 'to', false);
    const sourceLanguageDetectionText = value.sourceLanguageDetectionText;
    if (sourceLanguageDetectionText !== undefined && typeof sourceLanguageDetectionText !== 'string') {
        throw new TypeError('Chrome 源语言检测文本必须是字符串');
    }
    return {
        text,
        from,
        to,
        ...(sourceLanguageDetectionText?.trim() ? {sourceLanguageDetectionText} : {}),
    };
}

export function parseLanguageCode(value: unknown, field: string, allowAuto: boolean): string {
    if (typeof value !== 'string') throw new TypeError(`Chrome 翻译 ${field} 必须是语言代码`);
    const language = value.trim();
    if (allowAuto && language === 'auto') return language;
    if (!language || !LANGUAGE_CODE_PATTERN.test(language)) {
        throw new TypeError(`Chrome 翻译 ${field} 语言代码无效`);
    }
    return language;
}

export function mapChromeLanguageCode(language: string): string {
    const normalized = normalizeChineseLanguageCode(language);
    return normalized === 'zh-Hans' ? 'zh' : normalized;
}

/** 无检测器或检测器不确定时只接受高置信专属脚本；共享脚本、Latin 与纯 Han 保持未知。 */
export function detectLanguageByScript(text: string): string | null {
    const hasKana = /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text);
    const hasHangul = /\p{Script=Hangul}/u.test(text);
    if (hasKana && hasHangul) return null;
    if (hasKana) return 'ja';
    if (hasHangul) return 'ko';
    // Cyrillic、Arabic、Devanagari 与 Thai 都可能承载多种语言，失败时宁可让用户显式选择。
    return null;
}

export function detectedLanguageFrom(value: unknown, requireConfidence = true): string | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0];
    if (!isRecord(first) || typeof first.detectedLanguage !== 'string') return null;
    const detected = first.detectedLanguage.trim();
    if (!detected || detected.toLowerCase() === 'und' || !LANGUAGE_CODE_PATTERN.test(detected)) return null;
    const confidence = first.confidence;
    if (confidence === undefined && !requireConfidence) return detected;
    if (typeof confidence !== 'number'
        || !Number.isFinite(confidence)
        || confidence < MIN_CHROME_LANGUAGE_CONFIDENCE
        || confidence > 1) return null;
    return detected;
}

function createNamedError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

export interface ChromePreparationRequiredError extends Error {
    readonly code: 'preparation-required';
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
}

export function createChromePreparationRequiredError(
    sourceLanguage: string,
    targetLanguage: string,
): ChromePreparationRequiredError {
    const error = createNamedError(
        'ChromePreparationRequiredError',
        sourceLanguage === 'auto'
            ? '自动识别源语言需要先准备语言检测模型。请在「浏览器内置翻译」中点击「准备语言包」后重试。'
            : `浏览器内置翻译的 ${sourceLanguage} → ${targetLanguage} 语言包尚未准备。请在「浏览器内置翻译」中点击「准备语言包」后重试。`,
    ) as ChromePreparationRequiredError;
    Object.assign(error, {code: 'preparation-required', sourceLanguage, targetLanguage});
    return error;
}

export function isChromePreparationRequiredError(error: unknown): error is ChromePreparationRequiredError {
    return error instanceof Error
        && error.name === 'ChromePreparationRequiredError'
        && (error as Partial<ChromePreparationRequiredError>).code === 'preparation-required'
        && typeof (error as Partial<ChromePreparationRequiredError>).sourceLanguage === 'string'
        && typeof (error as Partial<ChromePreparationRequiredError>).targetLanguage === 'string';
}

function reportModelStatus(
    reporter: ChromeModelStatusReporter | undefined,
    status: ChromeModelStatus,
    signal?: AbortSignal,
): void {
    if (!reporter || signal?.aborted) return;
    try {
        reporter({...status});
    } catch {
        // 模型状态属于旁路观察；UI/测试 reporter 失败不能中断本地翻译。
    }
}

function parseModelAvailability(value: unknown): ChromeModelAvailability | undefined {
    return typeof value === 'string' && CHROME_MODEL_AVAILABILITIES.has(value as ChromeModelAvailability)
        ? value as ChromeModelAvailability
        : undefined;
}

async function checkModelAvailability(
    model: ChromeModelKind,
    operation: (() => Promise<unknown>) | undefined,
    reporter: ChromeModelStatusReporter | undefined,
    signal?: AbortSignal,
): Promise<ChromeModelAvailability | undefined> {
    reportModelStatus(reporter, {model, phase: 'checking'}, signal);
    throwIfAborted(signal);
    if (!operation) {
        reportModelStatus(reporter, {model, phase: 'initializing'}, signal);
        return undefined;
    }
    let availability: ChromeModelAvailability | undefined;
    try {
        availability = parseModelAvailability(await awaitWithAbort(
            Promise.resolve().then(operation),
            signal,
        ));
    } catch (error) {
        if (isAbortError(error)) throw error;
        // availability 是兼容性提示；未知实现抛错时仍让 create() 给出权威结果。
    }
    if (availability === 'unavailable') {
        throw createNamedError(
            'ChromeModelUnavailableError',
            model === 'language-detector' ? '浏览器语言检测模型不可用' : '浏览器翻译语言包不可用',
        );
    }
    reportModelStatus(reporter, {
        model,
        phase: availability === 'downloadable' || availability === 'downloading'
            ? 'downloading'
            : 'initializing',
        ...(availability ? {availability} : {}),
    }, signal);
    return availability;
}

function createModelOptions(
    model: ChromeModelKind,
    availability: ChromeModelAvailability | undefined,
    reporter: ChromeModelStatusReporter | undefined,
    signal?: AbortSignal,
): ChromeModelCreateOptions {
    return {
        signal,
        monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
                const loaded = event.loaded;
                if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded < 0 || loaded > 1) return;
                reportModelStatus(reporter, {
                    model,
                    phase: availability === 'available' || loaded >= 1
                        ? 'initializing'
                        : 'downloading',
                    ...(availability ? {availability} : {}),
                    loaded,
                }, signal);
            });
        },
    };
}

function safelyDestroy(resource: {destroy?: () => void}): void {
    try {
        resource.destroy?.();
    } catch {
        // 实验 API 的清理失败不能覆盖已经完成的检测或翻译结果。
    }
}

type ChromeResource = ChromeLanguageDetector | ChromeTranslator;
interface ChromeResourceSubscriber {
    readonly reporter?: ChromeModelStatusReporter;
    readonly signal?: AbortSignal;
}
interface ChromeCachedResource {
    readonly key: string;
    readonly kind: ChromeModelKind;
    readonly controller: AbortController;
    readonly subscribers: Set<ChromeResourceSubscriber>;
    promise: Promise<ChromeResource>;
    resource?: ChromeResource;
    status?: ChromeModelStatus;
    queue: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    lastUsed: number;
    retired: boolean;
    removed: boolean;
    drainTimedOut: boolean;
}
interface ChromeResourceCache {
    readonly entries: Map<string, ChromeCachedResource>;
    readonly waiters: Set<() => void>;
    disposed: boolean;
}
const chromeResourceCaches = new WeakMap<ChromeTranslationEnvironment, ChromeResourceCache>();
const CHROME_CANCEL_DRAIN_TIMEOUT_MS = 1_500;

function wakeChromeResourceWaiters(cache: ChromeResourceCache): void {
    for (const wake of cache.waiters) wake();
    cache.waiters.clear();
}

function removeChromeResource(cache: ChromeResourceCache, entry: ChromeCachedResource): void {
    if (entry.removed) return;
    entry.removed = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    cache.entries.delete(entry.key);
    // create.signal 是整个实例的生命周期，不能绑定某一个翻译请求。
    entry.controller.abort();
    if (entry.resource) safelyDestroy(entry.resource);
    wakeChromeResourceWaiters(cache);
}

/** 卸载 Offscreen 容器时同时取消创建、排队与推理，迟到资源仍由创建路径释放。 */
export function disposeChromeTranslationModels(environment: ChromeTranslationEnvironment): void {
    let cache = chromeResourceCaches.get(environment);
    if (!cache) {
        cache = {entries: new Map(), waiters: new Set(), disposed: true};
        chromeResourceCaches.set(environment, cache);
        return;
    }
    cache.disposed = true;
    for (const entry of cache.entries.values()) removeChromeResource(cache, entry);
    wakeChromeResourceWaiters(cache);
}

function throwIfChromeEnvironmentDisposed(environment: ChromeTranslationEnvironment): void {
    if (chromeResourceCaches.get(environment)?.disposed) throw createAbortError();
}

function releaseChromeResource(
    cache: ChromeResourceCache,
    entry: ChromeCachedResource,
    subscriber: ChromeResourceSubscriber,
): void {
    entry.subscribers.delete(subscriber);
    if (entry.removed || entry.subscribers.size > 0) return;
    entry.lastUsed = Date.now();
    if (!entry.resource || entry.retired) {
        removeChromeResource(cache, entry);
        return;
    }
    entry.timer = setTimeout(() => removeChromeResource(cache, entry), localModelIdleMs());
    wakeChromeResourceWaiters(cache);
}

async function waitForChromeResourceCapacity(cache: ChromeResourceCache, signal?: AbortSignal): Promise<void> {
    let wake!: () => void;
    const available = new Promise<void>(resolve => { wake = resolve; });
    cache.waiters.add(wake);
    try {
        await awaitWithAbort(available, signal);
    } finally {
        cache.waiters.delete(wake);
    }
}

/**
 * 同语言对首次并发共享创建；同实例任务串行，但取消只结束当前请求。
 * 容量满时只淘汰无租约的最旧实例，所有实例忙碌时等待，避免额外第三个语言对。
 */
async function runCachedChromeOperation<T extends ChromeResource, R>(
    environment: ChromeTranslationEnvironment,
    key: string,
    kind: ChromeModelKind,
    create: (signal: AbortSignal, reporter: ChromeModelStatusReporter) => Promise<T>,
    operation: (resource: T, lifecycleSignal: AbortSignal) => Promise<R>,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<R> {
    throwIfAborted(signal);
    let cache = chromeResourceCaches.get(environment);
    if (!cache) {
        cache = {entries: new Map(), waiters: new Set(), disposed: false};
        chromeResourceCaches.set(environment, cache);
    }
    let entry: ChromeCachedResource;
    while (true) {
        throwIfAborted(signal);
        if (cache.disposed) throw createAbortError();
        const existing = cache.entries.get(key);
        if (existing && !existing.retired) {
            entry = existing;
            break;
        }
        const peers = [...cache.entries.values()].filter(item => item.kind === kind);
        const capacity = kind === 'translator' ? 2 : 1;
        if (existing) {
            // retired 实例仍有租约；最后一个租约释放时会移除并唤醒等待者。
            await waitForChromeResourceCapacity(cache, signal);
            continue;
        } else if (peers.length >= capacity) {
            const idle = peers.filter(item => item.subscribers.size === 0)
                .sort((a, b) => a.lastUsed - b.lastUsed)[0];
            if (idle) removeChromeResource(cache, idle);
            else {
                await waitForChromeResourceCapacity(cache, signal);
                continue;
            }
        }
        entry = {
            key, kind, controller: new AbortController(), subscribers: new Set(),
            promise: Promise.resolve({} as T), queue: Promise.resolve(), lastUsed: Date.now(),
            retired: false, removed: false, drainTimedOut: false,
        };
        cache.entries.set(key, entry);
        const creatingEntry = entry;
        const creatingCache = cache;
        entry.promise = Promise.resolve().then(async () => {
            const resource = await create(creatingEntry.controller.signal, status => {
                creatingEntry.status = status;
                for (const subscriber of creatingEntry.subscribers) {
                    reportModelStatus(subscriber.reporter, status, subscriber.signal);
                }
            });
            if (creatingEntry.removed) {
                safelyDestroy(resource);
                throw createAbortError();
            }
            creatingEntry.resource = resource;
            return resource;
        }).catch(error => {
            removeChromeResource(creatingCache, creatingEntry);
            throw error;
        });
        break;
    }
    if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
    }
    const leasedEntry = entry;
    const leasedCache = cache;
    const subscriber = {reporter, signal};
    const cancelUnconsumedCreation = () => {
        // 状态 reporter 可在同一调用栈取消请求；不能等 job 的微任务清理再停止 create。
        if (!leasedEntry.resource && [...leasedEntry.subscribers].every(item => item.signal?.aborted)) {
            removeChromeResource(leasedCache, leasedEntry);
        }
    };
    entry.subscribers.add(subscriber);
    signal?.addEventListener('abort', cancelUnconsumedCreation, {once: true});
    if (entry.status) reportModelStatus(reporter, entry.status, signal);
    let unlock: (() => void) | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const handleActiveAbort = () => {
        drainTimer = setTimeout(() => {
            leasedEntry.drainTimedOut = true;
            removeChromeResource(leasedCache, leasedEntry);
        }, CHROME_CANCEL_DRAIN_TIMEOUT_MS);
    };
    const job = (async () => {
        try {
            const resource = await awaitWithAbort(leasedEntry.promise, signal) as T;
            const previous = leasedEntry.queue;
            const slot = new Promise<void>(resolve => { unlock = resolve; });
            leasedEntry.queue = previous.then(() => slot);
            await awaitWithAbort(awaitWithAbort(previous, leasedEntry.controller.signal), signal);
            throwIfAborted(signal);
            throwIfAborted(leasedEntry.controller.signal);
            if (leasedEntry.retired) {
                throw createNamedError('InvalidStateError', 'Chrome 本地模型实例已失效，请重新翻译');
            }
            // 原生取消通常立即确认；错误实现迟迟不收尾时销毁实例，避免永久占住队列。
            signal?.addEventListener('abort', handleActiveAbort, {once: true});
            return await awaitWithAbort(operation(resource, leasedEntry.controller.signal), leasedEntry.controller.signal);
        } catch (error) {
            // 单次取消或输入过长不销毁共享实例；底层失效待其余租约完成后重建。
            if (!signal?.aborted && !leasedEntry.controller.signal.aborted
                && !(error instanceof Error && error.name === 'QuotaExceededError')) leasedEntry.retired = true;
            if (leasedEntry.drainTimedOut && !signal?.aborted) {
                throw createNamedError('InvalidStateError', 'Chrome 本地模型未响应取消，已释放实例，请重新翻译');
            }
            throw error;
        }
    })().finally(() => {
        signal?.removeEventListener('abort', cancelUnconsumedCreation);
        signal?.removeEventListener('abort', handleActiveAbort);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        unlock?.();
        releaseChromeResource(leasedCache, leasedEntry, subscriber);
    });
    // caller 立即取消，内部 job 仍持有正在执行的实例，直到原生推理确认收尾。
    return awaitWithAbort(job, signal);
}

function createAbortError(): Error {
    const error = new Error('Chrome 翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): error is Error {
    return error instanceof Error && error.name === 'AbortError';
}

const PRESERVED_CHROME_API_ERROR_NAMES = new Set([
    'ChromeModelUnavailableError',
    'InvalidStateError',
    'NetworkError',
    'NotAllowedError',
    'NotSupportedError',
    'OperationError',
    'QuotaExceededError',
    'UnknownError',
]);

function isKnownChromeApiError(error: unknown): boolean {
    return error instanceof Error && PRESERVED_CHROME_API_ERROR_NAMES.has(error.name);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', handleAbort);
            callback();
        };
        const handleAbort = () => finish(() => reject(createAbortError()));
        signal.addEventListener('abort', handleAbort, {once: true});
        void promise.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
        );
    });
}

async function acquireAbortableResource<T extends {destroy?: () => void}>(
    promise: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    try {
        return await awaitWithAbort(promise, signal);
    } catch (error) {
        // 兼容实现可能忽略 create.signal；若资源迟到，必须在可用的第一刻释放。
        if (signal?.aborted) void promise.then(safelyDestroy, () => undefined);
        throw error;
    }
}

function closeStream(iterator: AsyncIterator<unknown>): void {
    try {
        if (typeof iterator.return === 'function') void Promise.resolve(iterator.return()).catch(() => undefined);
    } catch {
        // stream.return() 属于尽力清理；缓存会保留租约直到原生操作收尾。
    }
}

/** 检测器确认中文后才用字形精化；通用 zh 和共用汉字不能自行推定为简体。 */
function refineDetectedChineseLanguage(language: string, text: string): string {
    if (language.toLowerCase() !== 'zh') return normalizeChineseLanguageCode(language);
    const script = detectChineseScript(text);
    return script ? `zh-${script}` : 'zh';
}

export async function detectChromeLanguage(
    text: string,
    environment: ChromeTranslationEnvironment,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<string> {
    let detector: ChromeLanguageDetector | undefined;
    let detectionError: unknown;
    try {
        throwIfAborted(signal);
        throwIfChromeEnvironmentDisposed(environment);
        const modernDetector = environment.LanguageDetector;
        if (typeof modernDetector?.create === 'function') {
            const result = await runCachedChromeOperation(
                environment, 'language-detector', 'language-detector',
                async (creationSignal, sharedReporter) => {
                    const availability = await checkModelAvailability(
                        'language-detector',
                        typeof modernDetector.availability === 'function'
                            ? () => modernDetector.availability!()
                            : undefined,
                        sharedReporter,
                        creationSignal,
                    );
                    throwIfAborted(creationSignal);
                    const resource = await acquireAbortableResource(
                        modernDetector.create(createModelOptions(
                            'language-detector', availability, sharedReporter, creationSignal,
                        )), creationSignal,
                    );
                    reportModelStatus(sharedReporter, {
                        model: 'language-detector', phase: 'ready',
                        ...(availability ? {availability} : {}), loaded: 1,
                    }, creationSignal);
                    return resource;
                },
                resource => resource.detect(text, signal ? {signal} : undefined),
                signal, reporter,
            );
            const detected = detectedLanguageFrom(result);
            if (detected) return refineDetectedChineseLanguage(detected, text);
        } else if (typeof environment.translation?.createDetector === 'function') {
            detector = await acquireAbortableResource(environment.translation.createDetector(), signal);
            throwIfAborted(signal);
            const detected = detectedLanguageFrom(
                await awaitWithAbort(detector.detect(text), signal),
                false,
            );
            if (detected) return refineDetectedChineseLanguage(detected, text);
        }
    } catch (error) {
        if (isAbortError(error)) throw error;
        detectionError = error;
    } finally {
        if (detector) safelyDestroy(detector);
    }
    const scriptLanguage = detectLanguageByScript(text);
    if (scriptLanguage) return scriptLanguage;
    if (detectionError instanceof Error && (
        isKnownChromeApiError(detectionError)
        || /model|download|not ready|not available/iu.test(detectionError.message)
    )) throw detectionError;
    throw createNamedError(
        'ChromeLanguageUndeterminedError',
        '无法可靠识别源语言，请增加文本长度或手动选择源语言',
    );
}

async function acquireChromeTranslator(
    environment: ChromeTranslationEnvironment,
    options: ChromeTranslatorOptions,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<{translator: ChromeTranslator; modern: boolean}> {
    const modernTranslator = environment.Translator;
    if (typeof modernTranslator?.create === 'function') {
        const availability = await checkModelAvailability(
            'translator',
            typeof modernTranslator.availability === 'function'
                ? () => modernTranslator.availability!(options)
                : undefined,
            reporter,
            signal,
        );
        throwIfAborted(signal);
        const translator = await acquireAbortableResource(
            modernTranslator.create({
                ...options,
                ...createModelOptions('translator', availability, reporter, signal),
            }),
            signal,
        );
        reportModelStatus(reporter, {
            model: 'translator',
            phase: 'ready',
            ...(availability ? {availability} : {}),
            loaded: 1,
        }, signal);
        return {translator, modern: true};
    }
    if (typeof environment.translation?.createTranslator === 'function') {
        return {
            translator: await acquireAbortableResource(
                environment.translation.createTranslator(options),
                signal,
            ),
            modern: false,
        };
    }
    throw new Error('没有可用的翻译 API');
}

async function translateWithChromeTranslator(
    text: string,
    translator: ChromeTranslator,
    modern: boolean,
    signal?: AbortSignal,
    lifecycleSignal?: AbortSignal,
): Promise<string> {
    throwIfAborted(signal);
    if (typeof translator.translateStreaming === 'function') {
        let translated = '';
        const stream = modern && signal
            ? translator.translateStreaming(text, {signal})
            : translator.translateStreaming(text);
        const iterator = stream[Symbol.asyncIterator]();
        let completed = false;
        let closed = false;
        const close = () => {
            if (closed || completed) return;
            closed = true;
            closeStream(iterator);
        };
        signal?.addEventListener('abort', close, {once: true});
        lifecycleSignal?.addEventListener('abort', close, {once: true});
        try {
            while (true) {
                // 现代 signal 会中止原生流；保留队列租约直到原生 next() 确认结束。
                const next = modern ? await iterator.next()
                    : await awaitWithAbort(Promise.resolve(iterator.next()), signal);
                throwIfAborted(signal);
                if (next.done) {
                    completed = true;
                    break;
                }
                const chunk = next.value;
                if (typeof chunk !== 'string') throw new Error('翻译器返回了无效的流式结果');
                translated += chunk;
            }
        } finally {
            signal?.removeEventListener('abort', close);
            lifecycleSignal?.removeEventListener('abort', close);
            if (!completed) close();
        }
        return translated;
    }
    if (typeof translator.translate === 'function') {
        const result = modern && signal ? translator.translate(text, {signal}) : translator.translate(text);
        const translated = modern ? await result : await awaitWithAbort(result, signal);
        throwIfAborted(signal);
        if (typeof translated !== 'string') throw new Error('翻译器返回了无效结果');
        return translated;
    }
    throw new Error('翻译器不支持翻译方法');
}

export async function performChromeTranslation(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
    environment: ChromeTranslationEnvironment,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<string> {
    throwIfAborted(signal);
    throwIfChromeEnvironmentDisposed(environment);
    const options = {sourceLanguage, targetLanguage};
    if (typeof environment.Translator?.create === 'function') {
        const key = JSON.stringify([sourceLanguage.toLowerCase(), targetLanguage.toLowerCase()]);
        return runCachedChromeOperation(
            environment, key, 'translator',
            async (creationSignal, sharedReporter) => (await acquireChromeTranslator(
                environment, options, creationSignal, sharedReporter,
            )).translator,
            (translator, lifecycleSignal) => translateWithChromeTranslator(text, translator, true, signal, lifecycleSignal),
            signal, reporter,
        );
    }
    const {translator, modern} = await acquireChromeTranslator(environment, options, signal, reporter);
    try {
        return await translateWithChromeTranslator(text, translator, modern, signal);
    } finally {
        safelyDestroy(translator);
    }
}

export function friendlyChromeTranslationError(
    error: unknown,
    sourceLanguage: string,
    targetLanguage: string,
): Error {
    if (isAbortError(error)) return error;
    if (isChromePreparationRequiredError(error)) return error;
    const message = error instanceof Error ? error.message : String(error || '未知错误');
    const lowerMessage = message.toLowerCase();
    const errorName = error instanceof Error ? error.name : '';
    if (errorName === 'ChromeLanguageUndeterminedError') {
        return new Error(message);
    }
    if (errorName === 'NotAllowedError') {
        return createChromePreparationRequiredError(sourceLanguage, targetLanguage);
    }
    if (errorName === 'QuotaExceededError') {
        return new Error('待翻译文本超过浏览器内置翻译的单次长度限制，请缩短文本后重试。');
    }
    if (errorName === 'OperationError'
        || errorName === 'UnknownError'
        || errorName === 'NetworkError'
        || errorName === 'InvalidStateError') {
        return new Error('翻译模型未就绪，请稍后重试或检查网络连接。');
    }
    if (errorName === 'NotSupportedError'
        || errorName === 'ChromeModelUnavailableError'
        || lowerMessage.includes('not available')
        || lowerMessage.includes('not ready')
        || lowerMessage.includes('language')
        || lowerMessage.includes('not supported')) {
        return createNamedError('ChromeModelUnavailableError',
            `浏览器内置翻译当前不可用（${sourceLanguage} → ${targetLanguage}）。请在翻译服务设置中检查语言包或选择其他服务。`);
    }
    if (lowerMessage.includes('model')) {
        return new Error('翻译模型未就绪，请稍后重试或检查网络连接。');
    }
    return new Error(`翻译失败：${message}`);
}

export async function translateWithChromeApi(
    requestValue: unknown,
    environment: ChromeTranslationEnvironment,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<string> {
    throwIfAborted(signal);
    throwIfChromeEnvironmentDisposed(environment);
    const request = parseChromeTranslationRequest(requestValue);
    if (!request.text.trim()) return '';
    if (!hasBrowserTranslationApi(environment)) {
        throw createNamedError('BrowserTranslationApiUnavailableError', '当前浏览器未开放内置翻译接口，请检查浏览器版本或选择其他翻译服务。');
    }

    let sourceLanguage = request.from;
    let targetLanguage = request.to;
    let detectedGenericChinese = false;
    try {
        // 步骤 1：auto 只在源语言有效；检测文本与带哨兵的翻译正文严格分离。
        if (sourceLanguage === 'auto') {
            sourceLanguage = await detectChromeLanguage(
                request.sourceLanguageDetectionText ?? request.text,
                environment,
                signal,
                reporter,
            );
            detectedGenericChinese = sourceLanguage === 'zh';
        }
        throwIfChromeEnvironmentDisposed(environment);
        sourceLanguage = mapChromeLanguageCode(sourceLanguage);
        targetLanguage = mapChromeLanguageCode(targetLanguage);

        // 步骤 2：同语言直接返回原文，不创建昂贵的语言模型。
        if (!detectedGenericChinese && sourceLanguage === targetLanguage) return request.text;
        return await performChromeTranslation(
            request.text,
            sourceLanguage,
            targetLanguage,
            environment,
            signal,
            reporter,
        );
    } catch (error) {
        throw friendlyChromeTranslationError(error, sourceLanguage, targetLanguage);
    }
}

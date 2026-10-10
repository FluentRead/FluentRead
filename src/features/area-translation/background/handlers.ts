/**
 * @file src/features/area-translation/background/handlers.ts
 * 文件职责：定义圈选截图与圈选翻译在后台消息路由中的类型化处理器，并在进入浏览器截图和 Offscreen OCR 边界前校验所有不可信消息字段。
 * 主要内容：在准备文字与视觉事务时传递可信隐私来源；定义截图、圈选与取消协议，在 OCR 前冻结文本事务，依序执行本地裁剪识别及整块翻译并向原页面发送真实阶段；窗口、图像和选区在副作用前严格校验，截图请求全局串行并至少间隔 600ms，等待后及截图完成后均核对真实 sender 仍为活动标签页。
 * 模块边界：本文件只负责编排和输入防线，不直接访问 tabs、配置存储或 OCR 实现；这些副作用由 background composition root 注入，几何换算归 core，Offscreen 通信归 adapter。
 */
import type {AreaTranslationSelection} from '@/src/features/area-translation/core';
import {
    createImageOperationRegistry,
    IMAGE_PROGRESS_MESSAGE_TYPE,
    type ImageTranslationStage,
    type ImageOperationOptions,
} from '@/src/features/image-translation/protocol';

export const AREA_CAPTURE_MESSAGE_TYPE = 'fluentReadAreaCapture' as const;
export const AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE = 'fluentReadAreaTranslateCapture' as const;
export const AREA_CANCEL_MESSAGE_TYPE = 'fluentReadAreaCancel' as const;

export interface AreaTranslationBackgroundContext {
    sender?: {
        url?: string;
        frameId?: number;
        tab?: {
            id?: number;
            windowId?: number;
            incognito?: boolean;
        };
    };
}

export interface AreaCaptureMessage {
    type: typeof AREA_CAPTURE_MESSAGE_TYPE;
}

export interface AreaTranslateCaptureMessage {
    type: typeof AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE;
    image?: unknown;
    selection?: unknown;
    sourceLanguage?: unknown;
    title?: unknown;
    requestId?: unknown;
    timeoutMs?: unknown;
}

export interface AreaCancelMessage {
    type: typeof AREA_CANCEL_MESSAGE_TYPE;
    requestId?: unknown;
}

export type AreaTranslationBackgroundMessage = AreaCaptureMessage | AreaTranslateCaptureMessage | AreaCancelMessage;

export interface AreaCaptureResponse {
    success: true;
    image: string;
}

export interface AreaTranslationBackgroundDependencies<TResult extends object> {
    readonly captureVisibleTab: (windowId: number) => Promise<string | undefined>;
    readonly captureNow?: () => number;
    readonly waitForCapture?: (milliseconds: number) => Promise<void>;
    readonly getDefaultSourceLanguage: () => string;
    readonly assertCaptureOwner?: (windowId: number, tabId: unknown) => Promise<void>;
    readonly assertLanguagesDownloaded: (sourceLanguage: string) => Promise<void>;
    readonly getVisionRoute?: () => {mode: 'ocr' | 'vision'; fallback?: 'unsupported' | 'unknown'};
    readonly prepareVisionRoute?: () => (options: ImageOperationOptions) => Promise<{mode: 'ocr' | 'vision'; fallback?: 'unsupported' | 'unknown'}>;
    readonly translateAreaVision?: (
        image: string, sourceLanguage: string, title: string, selection: AreaTranslationSelection, options: ImageOperationOptions,
    ) => Promise<TResult>;
    readonly prepareVisionTranslation?: (sourceLanguage: string, title: string, context: AreaTranslationBackgroundContext) =>
        (image: string, selection: AreaTranslationSelection, options: ImageOperationOptions) => Promise<TResult>;
    readonly prepareTextTranslation?: (sourceLanguage: string, title: string, context: AreaTranslationBackgroundContext) =>
        (recognized: TResult, options: ImageOperationOptions) => Promise<object>;
    readonly sendProgress?: (context: AreaTranslationBackgroundContext, message: {type: typeof IMAGE_PROGRESS_MESSAGE_TYPE; requestId: string; stage: ImageTranslationStage}) => Promise<void>;
    readonly translateArea: (
        image: string,
        sourceLanguage: string,
        title: string,
        selection: AreaTranslationSelection,
        options: ImageOperationOptions,
    ) => Promise<TResult>;
}

export interface AreaTranslationBackgroundHandler<
    TMessage extends AreaTranslationBackgroundMessage,
    TResponse,
> {
    readonly type: TMessage['type'];
    handle(message: TMessage, context: AreaTranslationBackgroundContext): Promise<TResponse>;
}

export function isAreaTranslationSelection(value: unknown): value is AreaTranslationSelection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const selection = value as Record<string, unknown>;
    const numericFields = ['left', 'top', 'width', 'height', 'viewportWidth', 'viewportHeight'] as const;
    return numericFields.every((key) => typeof selection[key] === 'number' && Number.isFinite(selection[key]))
        && Number(selection.width) >= 12
        && Number(selection.height) >= 12
        && Number(selection.viewportWidth) > 0
        && Number(selection.viewportHeight) > 0;
}

function parseWindowId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('无法确定当前页面窗口');
    }
    return value;
}

/** 截图前后核对真实 sender 所属活动标签页，避免切换标签时采集到另一页内容。 */
export function createAreaCaptureOwnershipVerifier(
    getTab: (tabId: number) => Promise<{id?: number; windowId: number; active: boolean}>,
): (windowId: number, tabId: unknown) => Promise<void> {
    return async (windowId, tabId) => {
        if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) {
            throw new Error('无法确定圈选截图所属标签页');
        }
        const tab = await getTab(tabId);
        if (tab.id !== tabId || tab.windowId !== windowId || !tab.active) {
            throw new Error('圈选页面已切换，请返回原页面重新圈选');
        }
    };
}

function parseDataImage(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('data:image/')) {
        throw new TypeError('圈选截图数据无效');
    }
    return value;
}

function parseSourceLanguage(value: unknown, fallback: string): string {
    const candidate = value === undefined ? fallback : value;
    if (typeof candidate !== 'string' || !candidate.trim()) {
        throw new TypeError('圈选翻译 sourceLanguage 必须是非空字符串');
    }
    return candidate;
}

function parseTitle(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new TypeError('圈选翻译 title 必须是字符串');
    return value;
}

function areaAbortError(): Error {
    const error = new Error('圈选翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

/** 创建区域截图与翻译 handlers；tabs/offscreen/config 均由 app composition root 注入。 */
export function createAreaTranslationBackgroundHandlers<TResult extends object>(
    dependencies: AreaTranslationBackgroundDependencies<TResult>,
): [
    AreaTranslationBackgroundHandler<AreaCaptureMessage, AreaCaptureResponse>,
    AreaTranslationBackgroundHandler<AreaTranslateCaptureMessage, {success: true} & object>,
    AreaTranslationBackgroundHandler<AreaCancelMessage, {success: true; cancelled: boolean; requestId: string}>,
] {
    const operationRegistry = createImageOperationRegistry('area');
    const captureNow = dependencies.captureNow ?? Date.now;
    const waitForCapture = dependencies.waitForCapture ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    // Chrome 每秒最多 2 次 captureVisibleTab；共享串行队列以实际启动时间间隔 600ms，失败仍释放后续任务。
    // https://developer.chrome.com/docs/extensions/reference/api/tabs#property-MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
    let captureQueue: Promise<void> = Promise.resolve();
    let lastCaptureStartedAt = Number.NEGATIVE_INFINITY;
    return [
        {
            type: AREA_CAPTURE_MESSAGE_TYPE,
            async handle(_message, context) {
                const windowId = parseWindowId(context.sender?.tab?.windowId);
                const tabId = context.sender?.tab?.id;
                const operation = captureQueue.then(async (): Promise<AreaCaptureResponse> => {
                    const delay = 600 - (captureNow() - lastCaptureStartedAt);
                    if (delay > 0) await waitForCapture(delay);
                    // 排队期间用户可能已切页；只有等待结束后核验通过才能消耗截图额度。
                    await dependencies.assertCaptureOwner?.(windowId, tabId);
                    lastCaptureStartedAt = captureNow();
                    const image = await dependencies.captureVisibleTab(windowId);
                    await dependencies.assertCaptureOwner?.(windowId, tabId);
                    if (typeof image !== 'string' || !image) throw new Error('当前页面截图为空');
                    return {success: true, image};
                });
                captureQueue = operation.then(() => undefined, () => undefined);
                return operation;
            },
        },
        {
            type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE,
            async handle(message, context) {
                // 步骤 1：严格验证截图、视口选区和字符串字段，再进入 OCR/offscreen 边界。
                const image = parseDataImage(message.image);
                if (!isAreaTranslationSelection(message.selection)) throw new TypeError('圈选区域无效');
                const sourceLanguage = parseSourceLanguage(
                    message.sourceLanguage,
                    dependencies.getDefaultSourceLanguage(),
                );
                const title = parseTitle(message.title);

                // 在任何 OCR await 前冻结完整文本翻译事务，后续设置变更不改变当前任务。
                const translateText = dependencies.prepareTextTranslation?.(sourceLanguage, title, context);
                const translateVision = dependencies.prepareVisionTranslation?.(sourceLanguage, title, context);
                const visionRoute = dependencies.getVisionRoute?.() ?? {mode: 'ocr' as const};
                const resolveVisionRoute = dependencies.prepareVisionRoute?.();
                // 步骤 2：先确认语言包，再复用同一个 offscreen 区域识别事务。
                const result = await operationRegistry.run(message, async (options) => {
                    if (resolveVisionRoute) await dependencies.sendProgress?.(context, {type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: options.requestId, stage: 'recognizing'});
                    const route = resolveVisionRoute ? await resolveVisionRoute(options) : visionRoute;
                    if (route.mode === 'vision' && !translateVision && !dependencies.translateAreaVision) throw new Error('视觉圈选翻译不可用');
                    if (route.mode === 'ocr') await dependencies.assertLanguagesDownloaded(sourceLanguage);
                    if (options.signal.aborted) throw areaAbortError();
                    if (!resolveVisionRoute) await dependencies.sendProgress?.(context, {type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: options.requestId, stage: 'recognizing'});
                    const recognized = route.mode === 'vision'
                        ? translateVision
                            ? await translateVision(image, message.selection as AreaTranslationSelection, options)
                            : await dependencies.translateAreaVision!(image, sourceLanguage, title, message.selection as AreaTranslationSelection, options)
                        : await dependencies.translateArea(image, sourceLanguage, title, message.selection as AreaTranslationSelection, options);
                    if (options.signal.aborted) throw areaAbortError();
                    const withRecognition = (dependencies.getVisionRoute || resolveVisionRoute) && route.mode === 'ocr'
                        ? {...recognized, recognitionMethod: 'ocr' as const, ...(route.fallback ? {recognitionFallback: route.fallback} : {})}
                        : recognized;
                    if (!translateText) return withRecognition;
                    await dependencies.sendProgress?.(context, {type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId: options.requestId, stage: 'translating'});
                    return translateText(withRecognition, options);
                });
                return {success: true, ...result};
            },
        },
        {
            type: AREA_CANCEL_MESSAGE_TYPE,
            async handle(message) {
                return operationRegistry.cancel(message.requestId);
            },
        },
    ];
}

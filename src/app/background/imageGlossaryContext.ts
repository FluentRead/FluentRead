/**
 * @file src/app/background/imageGlossaryContext.ts
 * 文件职责：在图片与圈选 OCR 跨越 Offscreen 后恢复其真实原页面术语范围，并保证一次识别翻译事务使用开始时的术语版本。
 * 主要内容：包装已通过能力门控的图片和圈选 handler，以活跃 requestId 保存可信隐私、只读页面、源语言和版本快照；只有当前扩展精确的无标签页 Offscreen 发送者能取回事务，结束后立即清理。
 * 模块边界：本文件是可独立验证的后台装配规则，通过依赖注入接收配置就绪状态及 Offscreen URL；不访问 browser、不传输词表、不执行 OCR，也不信任消息中的页面 URL 或版本声明。
 */
import type {BackgroundMessage, BackgroundMessageHandler} from './messageRouter';
import {AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE} from './handlers/areaTranslation';
import {IMAGE_TRANSLATE_MESSAGE_TYPE, IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE} from './handlers/imageTranslation';
import {attachTranslationGlossaryContext, translationPrivacyContext, type TrustedTranslationSenderContext} from '@/src/services/translation/requestSnapshot';

export interface ImageGlossarySenderContext extends TrustedTranslationSenderContext {}

interface ImageGlossarySnapshot {
    readonly pageUrl: string | undefined;
    readonly privateContext?: boolean;
    readonly sourceLanguage: string;
    readonly glossaryRevision: string;
}

interface ImageGlossaryMessage extends BackgroundMessage {
    requestId?: unknown;
    sourceLanguage?: unknown;
}

export interface ImageGlossaryContextDependencies {
    readonly ready: Promise<unknown>;
    readonly offscreenUrl: string;
    readonly getSourceLanguage: () => string;
    readonly getGlossaryRevision: () => string;
}

function pageUrlFromSender(context: ImageGlossarySenderContext): string | undefined {
    const value = context.sender?.url;
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** 活跃 OCR 事务才可恢复；不把用户给出的 requestId 当成跨页面查询权限。 */
export function createImageGlossaryContext<TContext extends ImageGlossarySenderContext>(
    dependencies: ImageGlossaryContextDependencies,
): {wrap(handlers: readonly BackgroundMessageHandler<TContext>[]): BackgroundMessageHandler<TContext>[]} {
    const active = new Map<string, Readonly<ImageGlossarySnapshot>>();
    let sequence = 0;
    const snapshot = (context: TContext, sourceLanguage: unknown): Readonly<ImageGlossarySnapshot> => Object.freeze({
        pageUrl: pageUrlFromSender(context),
        ...translationPrivacyContext(context),
        sourceLanguage: typeof sourceLanguage === 'string' && sourceLanguage.trim()
            ? sourceLanguage : dependencies.getSourceLanguage(),
        glossaryRevision: dependencies.getGlossaryRevision(),
    });
    const requestId = (value: unknown): string => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
            throw new TypeError('图片翻译 requestId 格式无效');
        }
        return value;
    };
    return {
        wrap: (handlers) => handlers.map((handler) => {
            const startsTransaction = handler.type === IMAGE_TRANSLATE_MESSAGE_TYPE || handler.type === AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE;
            if (!startsTransaction && handler.type !== IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE) return handler;
            return {
                type: handler.type,
                async handle(rawMessage, context) {
                    await dependencies.ready;
                    const message = rawMessage as ImageGlossaryMessage;
                    if (startsTransaction) {
                        let id: string;
                        if (message.requestId === undefined) {
                            do { id = `legacy-image-glossary-${++sequence}`; } while (active.has(id));
                        } else id = requestId(message.requestId);
                        if (active.has(id)) throw new Error('图片 OCR requestId 正在执行');
                        const frozen = snapshot(context, message.sourceLanguage);
                        active.set(id, frozen);
                        try {
                            return await handler.handle({...message, requestId: id} as BackgroundMessage, context);
                        } finally {
                            active.delete(id);
                        }
                    }
                    const sender = context.sender;
                    const fromOffscreen = sender?.url === dependencies.offscreenUrl && sender.tab === undefined;
                    const frozen = fromOffscreen ? active.get(requestId(message.requestId)) : snapshot(context, undefined);
                    if (!frozen) throw new Error('图片翻译上下文已失效，请重新翻译');
                    return handler.handle(attachTranslationGlossaryContext({
                        ...message, glossaryRevision: frozen.glossaryRevision, sourceLanguage: frozen.sourceLanguage,
                    }, {pageUrl: frozen.pageUrl, context: 'page',
                        ...(frozen.privateContext === undefined ? {} : {privateContext: frozen.privateContext})}), context);
                },
            };
        }),
    };
}

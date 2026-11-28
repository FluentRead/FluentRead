/**
 * @file src/app/offscreen/messageRouter.ts
 * 文件职责：组合并分派发送到扩展自有 Offscreen DOM 页面的可信运行时消息，为翻译、TTS、图片 OCR、视频转写、读音标注和信息高亮提供统一消息入口。
 * 主要内容：导出 OffscreenSendResponse、OffscreenMessageDependencies 与 createOffscreenMessageListener，通过类型路由表聚合 routes/ttsRoutes、routes/translationRoutes、routes/imageRoutes 与 routes/mediaAndHighlightRoutes，并处理 ready 握手与 INFORMATION_HIGHLIGHT_ 前缀分派。
 * 模块边界：路由器不创建 Audio/Worker、不调用 browser.offscreen，也不实现具体翻译或推理算法；各域参数校验与取消纪律由同级 routes/* 模块承接。
 */

import {OFFSCREEN_READY_MESSAGE_TYPE} from '@/src/platform/offscreen/client';
import {createImageRoutes} from './routes/imageRoutes';
import {createInformationHighlightHandler, createMediaAndHighlightRoutes} from './routes/mediaAndHighlightRoutes';
import {
    isRecord,
    type OffscreenMessageDependencies,
    type OffscreenRouteMap,
    type OffscreenSendResponse,
} from './routes/shared';
import {createTranslationRoutes} from './routes/translationRoutes';
import {createTtsRoutes} from './routes/ttsRoutes';

export type {OffscreenMessageDependencies, OffscreenSendResponse};

type OffscreenMessageListener = (
    message: unknown,
    sender: unknown,
    sendResponse: OffscreenSendResponse,
) => boolean;

/** 静态路由 Offscreen 消息；未知或非对象消息不会占用其他 runtime listener。 */
export function createOffscreenMessageListener(dependencies: OffscreenMessageDependencies): OffscreenMessageListener {
    const informationHighlightHandler = createInformationHighlightHandler(dependencies);
    const routes: OffscreenRouteMap = {
        [OFFSCREEN_READY_MESSAGE_TYPE]: (_message, _sender, sendResponse) => {
            sendResponse({success: true, ready: true});
            return true;
        },
        ...createTtsRoutes(dependencies),
        ...createTranslationRoutes(dependencies),
        ...createImageRoutes(dependencies),
        ...createMediaAndHighlightRoutes(dependencies),
    };

    return (message, sender, sendResponse) => {
        if (!isRecord(message) || typeof message.type !== 'string') return false;
        if (message.target !== 'offscreen') return false;
        if (message.type.startsWith('INFORMATION_HIGHLIGHT_')) {
            return informationHighlightHandler(message, sender, sendResponse);
        }
        const handler = Object.hasOwn(routes, message.type) ? routes[message.type] : undefined;
        return handler ? handler(message, sender, sendResponse) : false;
    };
}

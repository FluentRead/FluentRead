/**
 * @file src/app/background/capabilityRegistry.ts
 * 文件职责：把浏览器能力探测结果转化为后台消息处理器和划词朗读传输的可用集合，使组合根只注册当前宿主真正支持的能力。
 * 主要内容：接收区域翻译、图片翻译等 handler 工厂并按 BrowserCapabilities 选择性实例化，同时为 Selection TTS 返回 扩展 DOM 播放传输或页面播放后备实现。
 * 模块边界：本文件只做能力门控与依赖选择，不探测浏览器品牌、不实现 OCR、区域翻译或音频播放；具体业务由 feature 工厂和 platform capability 模块承担。
 */
import type {BackgroundMessageHandler} from './messageRouter';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';

export interface CapabilityGatedBackgroundFactories<TContext> {
    readonly areaTranslation: () => Array<BackgroundMessageHandler<TContext>>;
    readonly imageTranslation: () => Array<BackgroundMessageHandler<TContext>>;
}

/** 不支持的 feature 连 factory 都不调用，避免在未适配目标注册必失败消息 handler。 */
export function createCapabilityGatedBackgroundHandlers<TContext>(
    capabilities: BrowserCapabilities,
    factories: CapabilityGatedBackgroundFactories<TContext>,
): Array<BackgroundMessageHandler<TContext>> {
    const handlers: Array<BackgroundMessageHandler<TContext>> = [];
    if (capabilities.areaTranslation) handlers.push(...factories.areaTranslation());
    if (capabilities.imageTranslation) handlers.push(...factories.imageTranslation());
    return handlers;
}

export function createCapabilityGatedSelectionTtsTransport<TRequest, TRoute>(
    capabilities: BrowserCapabilities,
    transport: {
        readonly play: (request: TRequest) => Promise<void>;
        readonly stop: (route: TRoute) => Promise<void>;
    },
): {
    readonly play: (request: TRequest) => Promise<void>;
    readonly stop: (route: TRoute) => Promise<void>;
} {
    if (capabilities.selectionTtsExtensionPlayback) return transport;
    return {
        // handler 在 page-only 模式下不会调用 play；保留签名避免分裂协议。
        play: transport.play,
        stop: async () => undefined,
    };
}

/**
 * @file src/app/content/hoverTranslationConfig.ts
 * 文件职责：在内容脚本配置同步边界撤销已失效的悬浮待触发任务，防止设置改变后仍按旧语言、服务或候选范围翻译。
 * 主要内容：仅在订阅回调中比较手势、候选、请求和展示配置的无凭据身份，同值回声及无关界面设置保持待触发任务；有效变化交给现有取消端口处理。
 * 模块边界：不持有鼠标或译文状态，不订阅存储，不取消已启动请求；顶层与受支持 frame 的组合根共享此配置同步适配器。
 */
import type {Config} from '@/src/core/config/model';
import {resolveConfiguredModel} from '@/src/core/config/catalog';
import {isModelThinkingEnabled} from '@/src/core/config/modelThinking';
import {buildGlossaryRevision} from '@/src/core/glossary';

function hoverConfigIdentity(source: Config): string {
    const service = source.hoverTranslationService || source.service;
    const model = resolveConfiguredModel(source.model[service], source.customModel[service]);
    return JSON.stringify([
        source.on, source.hotkey, source.customHotkey, source.mouseHoverTranslationDelay,
        source.translationScope, source.minTranslationTextLength, source.sidebarTranslationEnabled,
        service, model, isModelThinkingEnabled(source.modelThinking, service, model),
        source.from, source.to, source.excludedLanguages, source.useCache,
        source.enableAIContext, source.enableAIMultiSegment, source.nativeBatchTranslationEnabled[service],
        buildGlossaryRevision(source.glossaryLibraries, source.glossaryEnabled),
        source.display, source.style, source.longParagraphLineBreakEnabled, source.translationBeforeOriginal,
    ]);
}

/** 配置存储同值回声不取消任务，只有本页悬浮行为实际改变时才调用现有取消端口。 */
export function createHoverTranslationConfigInvalidator(source: Config, cancelPending: () => void): (next: Config) => void {
    let identity = hoverConfigIdentity(source);
    return next => {
        const nextIdentity = hoverConfigIdentity(next);
        if (nextIdentity === identity) return;
        identity = nextIdentity;
        cancelPending();
    };
}

/** 将请求配置失效检查接入手势已有的订阅与清理边界，组合根不另建一份悬浮生命周期。 */
export function createHoverTranslationConfigSubscription(
    source: Config,
    subscribe: (listener: (next: Config) => void) => () => void,
    cancelPending: () => void,
): (listener: () => void) => () => void {
    return listener => {
        const invalidate = createHoverTranslationConfigInvalidator(source, cancelPending);
        return subscribe(next => { invalidate(next); listener(); });
    };
}

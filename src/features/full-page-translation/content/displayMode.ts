/**
 * @file src/features/full-page-translation/content/displayMode.ts
 * 文件职责：复用已提交的原译文槽即时切换网页双语、仅译文及上下顺序，保留宿主原文身份与恢复能力。
 * 主要内容：复验来源及现有工件后，仅替换扩展自己的双语容器或闭合 Shadow 文本槽；普通网页优先应用网站仅译文偏好，沿用冻结的语言、样式和服务限制，明确同步当前译文位置，单语顺序变化仅更新重放偏好，同值回声不遍历页面；模式切换跳过显式快捷方案，校订更新可原位重绘当前模式。
 * 模块边界：不请求 provider、不修改会话配置、不创建消息或订阅；content 现有配置订阅与 runtime 提交入口调用本模块。
 */
import {applyTranslationsToSnapshot, collectLiveTranslationTextSlots, createTranslationSourceSnapshot,
    getCurrentTranslationCore} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {resolveSiteTranslationDisplay, type SiteTranslationDisplayConfig} from '@/src/core/site-rules/domain';
import {refreshBilingualTranslationSkeleton} from './bilingualReplay';
import {appendBilingualTranslation, appendSingleTranslationSlots} from './renderer';
import {getTranslationOwnersWithin, getTranslationState, resetTranslationPresentation,
    setBilingualContent, setLiveTranslationSourceSnapshot, setRenderedStyleAttribute, setSingleTextSlotHosts,
    type TranslationState} from './state';
import {getTranslationStateProtectionBoundary, getTranslationTextProtectionOptions,
    isTranslationArtifactCurrent, statefulSourceAndTextSlotsAreCurrent} from './translationStability';
import {withFullPageViewportAnchor} from './viewportStability';

/** 请求与显示解耦：显式模式覆盖与 Google 的双语限制始终沿用本次请求。 */
export function syncTranslationDisplayMode(node: HTMLElement, state: TranslationState, display: number, refresh = false,
    translationBeforeOriginal?: boolean): boolean {
    const replay = state.bilingualReplay;
    const requestedMode = display === 0 ? 'single' : 'bilingual';
    // 服务或快捷方案只约束显示模式；全局上下顺序仍应能应用于其现有双语结果。
    const mode = !refresh && (replay?.displayModeOverridden || requestedMode === 'single' && replay?.service === 'google')
        ? state.mode : requestedMode;
    const orderChanged = translationBeforeOriginal !== undefined && Boolean(replay?.translationBeforeOriginal) !== translationBeforeOriginal;
    if (!node.isConnected || state.kind !== 'content' || state.phase !== 'translated' || !replay ||
        (!refresh && state.mode === mode && !orderChanged)) return false;
    if ((!statefulSourceAndTextSlotsAreCurrent(node, state) && !refreshBilingualTranslationSkeleton(node, state)) ||
        !isTranslationArtifactCurrent(node, state)) return false;
    const core = getCurrentTranslationCore(state.scope);
    const boundary = getTranslationStateProtectionBoundary(node, state);
    const protection = getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node);
    const parts = collectLiveTranslationTextSlots(node, core.shouldStayOriginal, boundary, {
        ...protection,
        sourceTextSlotHosts: new Set((state.singleTextSlotHosts || []).map(({host}) => host)),
    });
    if (parts.length !== replay.sources.length || replay.translations.length !== parts.length ||
        parts.some((part, index) => part.source !== replay.sources[index])) return false;

    const currentReplay = orderChanged ? {...replay, translationBeforeOriginal} : replay;
    if (orderChanged) {
        state.bilingualReplay = currentReplay;
        // 仅译文下无需重建闭合文本槽；回到双语时使用最新顺序。
        if (!refresh && state.mode === mode && mode === 'single') return true;
    }

    withFullPageViewportAnchor(() => {
        resetTranslationPresentation(node, state, mode);
        if (mode === 'single') {
            setLiveTranslationSourceSnapshot(node, parts.map(({node: source}) => source));
            setSingleTextSlotHosts(node, appendSingleTranslationSlots(node, parts.map((part, index) => ({node: part.node,
                text: `${part.prefix}${currentReplay.translations[index]}${part.suffix}`})), currentReplay));
        } else {
            // 必须先解包自有文本槽：原始 Text 身份不变，安全骨架仍从当前宿主属性构建。
            const snapshot = createTranslationSourceSnapshot(node, core.shouldStayOriginal, boundary,
                protection, core.shouldOmitFromTranslation);
            const text = applyTranslationsToSnapshot(snapshot, currentReplay.translations);
            const content = appendBilingualTranslation(node, text, {...currentReplay,
                sourceSkeleton: snapshot.clone, sourceText: currentReplay.sources.join('\n')});
            setBilingualContent(node, content, currentReplay);
        }
        setRenderedStyleAttribute(node);
    }, [node]);
    return true;
}

/** 校订底稿更新只重绘当前模式，显式快捷方案的模式与请求身份保持不变。 */
export function refreshTranslationPresentation(node: HTMLElement, state: TranslationState): boolean {
    return syncTranslationDisplayMode(node, state, state.mode === 'single' ? 0 : 1, true);
}

/** 迟到的安全骨架重放完成后补齐当前显示偏好，避免同值配置去重留下旧模式。 */
export function refreshTranslationDisplayMode(node: HTMLElement, state: TranslationState): boolean {
    if (!refreshBilingualTranslationSkeleton(node, state)) return false;
    syncTranslationDisplayMode(node, state, resolveSiteTranslationDisplay(config, typeof location === 'undefined' ? '' : location.href), false, config.translationBeforeOriginal);
    return true;
}

/** 只遍历现有活动所有者，包含开放 ShadowRoot；失败态与未完成请求交给各自原生命周期。 */
export function syncPageTranslationDisplayMode(display: number, translationBeforeOriginal?: boolean): void {
    for (const owner of getTranslationOwnersWithin(document)) {
        // 活动索引在同步枚举时只返回仍有状态的 owner，中间不跨越异步或宿主回调。
        syncTranslationDisplayMode(owner, getTranslationState(owner)!, display, false, translationBeforeOriginal);
    }
}

/** 配置订阅只在显示或顺序变化时遍历工件，三个 content 装配入口共用同一去重规则。 */
export function createPageTranslationDisplayModeSync<T extends SiteTranslationDisplayConfig & {translationBeforeOriginal?: boolean}>(
    initial: T,
    applyPreferences: (next: T) => void,
): (next: T) => void {
    const display = (settings: T) => resolveSiteTranslationDisplay(settings, typeof location === 'undefined' ? '' : location.href);
    let previous = display(initial);
    let previousOrder = Boolean(initial.translationBeforeOriginal);
    return next => {
        // 先完成候选范围、站点规则与生命周期的现有协调，再重排仍存活的工件。
        applyPreferences(next);
        const nextOrder = Boolean(next.translationBeforeOriginal);
        const nextDisplay = display(next);
        if (nextDisplay === previous && nextOrder === previousOrder) return;
        previous = nextDisplay;
        previousOrder = nextOrder;
        syncPageTranslationDisplayMode(nextDisplay, next.translationBeforeOriginal);
    };
}

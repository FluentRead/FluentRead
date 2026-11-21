/**
 * @file src/app/content/informationHighlight.ts
 * 文件职责：装配当前页面的信息高亮控制器，将扩展模型消息端口适配成可取消的纯文本评分函数。
 * 主要内容：持有激活实例、页面快照和请求身份，完整释放失效请求；快捷键只开关当前页面（在输入框和编辑器里打字时不接管），并通过注入的通知端口反馈开启（本地模型方式说明正在分析）、关闭或不支持；本地模型尚未下载或设备无法运行时，本页改用关键词方式并说明原因，设置中的开关决定页面挂载、配置变化和路由切换后是否自动高亮，消息仍可临时开关当前页；未激活页面始终返回关闭状态。
 * 模块边界：只通过 feature public 与纯数据 protocol 装配，不导入 Worker、模型或后台内部实现，不写配置，不接触宿主原文。
 */
import {installInformationHighlight, type InformationHighlightController} from '@/src/features/information-highlight/public';
import type {InformationHighlightState} from '@/src/features/information-highlight/protocol';
import {normalizeInformationHighlightPreferences, type InformationHighlightPreferences} from '@/src/core/config/informationHighlight';
import {readVisibleTranslationRoot} from '@/src/features/full-page-translation/content/public';
import {matchesConfiguredHotkey} from '@/src/core/hotkey';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {showPageNotice} from '@/src/features/page-notice/public';
import type {ContentFeatureDefinition} from './featureRegistry';
import {createInformationHighlightScorePort} from './informationHighlightScorePort';
export {createInformationHighlightScorePort};
export interface InformationHighlightContentRuntime {
    mount(signal: AbortSignal, isCurrent: () => boolean): void;
    unmount(): void;
    getState(): InformationHighlightState;
    setEnabled(enabled: boolean): InformationHighlightState;
    retry(): InformationHighlightState;
    updatePreferences(preferences: InformationHighlightPreferences): void;
    routeChanged(): void;
}
export type InformationHighlightNotice = 'on' | 'onModel' | 'off' | 'modelNotReady' | 'modelUnsupported' | 'error' | 'unsupported';
export interface InformationHighlightMessageState {
    isSiteDisabled(): boolean;
    isPageSuspended?(): boolean;
    informationHighlight?: Pick<InformationHighlightContentRuntime, 'getState' | 'setEnabled' | 'retry'>;
}
/** undefined 表示其他功能消息；false 表示本功能参数无效，不吞掉未知协议。 */
export function handleInformationHighlightMessage(payload: Record<string, unknown>, state: InformationHighlightMessageState,
    contextDisabled: boolean, sendResponse: (response: unknown) => void): boolean | undefined {
    if (!['GET_INFORMATION_HIGHLIGHT_STATE', 'SET_INFORMATION_HIGHLIGHT_ENABLED', 'RETRY_INFORMATION_HIGHLIGHT'].includes(payload.type as string)) return undefined;
    const feature = state.informationHighlight;
    if (!feature) {sendResponse({success: false, error: 'INFORMATION_HIGHLIGHT_PAGE_UNAVAILABLE'}); return true;}
    if (payload.type === 'SET_INFORMATION_HIGHLIGHT_ENABLED' && typeof payload.enabled !== 'boolean') return false;
    const restricted = contextDisabled || state.isSiteDisabled() || state.isPageSuspended?.();
    if (payload.type === 'GET_INFORMATION_HIGHLIGHT_STATE') sendResponse({success: true, state: feature.getState()});
    else if (restricted && payload.enabled !== false) sendResponse({success: false, state: feature.getState(), error: 'INFORMATION_HIGHLIGHT_PAGE_DISABLED'});
    else sendResponse({success: true, state: payload.type === 'RETRY_INFORMATION_HIGHLIGHT' ? feature.retry() : feature.setEnabled(payload.enabled === true)});
    return true;
}
export function createInformationHighlightContentRuntime(ports: {
    document: Document;
    preferences: InformationHighlightPreferences;
    send(message: {type: string; text?: string; requestId: string}): Promise<unknown>;
    readTranslationRoot?(host: Element): ShadowRoot | undefined;
    translateRange?(range: Range): void;
    canToggle?(): boolean;
    notice?(message: InformationHighlightNotice): void;
}): InformationHighlightContentRuntime {
    let controller: InformationHighlightController | undefined, preference = normalizeInformationHighlightPreferences(ports.preferences);
    const scoreLocal = createInformationHighlightScorePort(ports.send);
    const idle = (): InformationHighlightState => ({enabled: false, phase: 'idle', sessionId: '0', processedParagraphs: 0,
        queuedParagraphs: 0, highlightedSpans: 0, mode: preference.mode});
    function unmount(): void {controller?.dispose(); controller = undefined;}
    return {
        mount(signal, isCurrent) {
            if (signal.aborted || !isCurrent() || controller) return;
            // 只有快捷键开启的会话才提示问题，且每次开启最多提示一次；自动高亮在后台页面保持安静。
            let announce = false;
            const owner = installInformationHighlight(ports.document, preference, {scoreLocal, isCurrent, readTranslationRoot: ports.readTranslationRoot,
                translateRange: ports.translateRange, changed(state) {
                if (state.phase !== 'error' && state.phase !== 'unsupported') return;
                // 本地模型还没下载或这台设备跑不了：这一页改用关键词方式，读者仍然得到高亮；设置不变，之后的页面仍先尝试模型。
                const code = state.mode === 'surprisal-local' ? String(state.errorCode) : '';
                const reason = code.includes('NOT_DOWNLOADED') ? 'modelNotReady' : /WEBGPU_UNAVAILABLE|F16_UNAVAILABLE/u.test(code) ? 'modelUnsupported' : undefined;
                if (reason) queueMicrotask(() => {if (controller === owner && owner.getState().enabled) owner.updatePreferences({...preference, mode: 'keywords'});});
                if (!announce) return;
                announce = false;
                ports.notice?.(reason ?? (state.phase === 'unsupported' ? 'unsupported' : 'error'));
            }});
            controller = owner;
            if (preference.enabled) owner.setEnabled(true);
            // 快捷键只切换这个页面的会话，不写配置；网站停用或页面挂起时不接管按键。
            ports.document.addEventListener('keydown', event => {
                if (!event.isTrusted || event.repeat || controller !== owner || !isCurrent() || ports.canToggle?.() === false
                    || !preference.hotkeyEnabled || !matchesConfiguredHotkey(event, 'custom', preference.hotkey)) return;
                // 正在输入框或编辑器里打字：不带 Ctrl/Command 的组合键可能是在输入字符（macOS 的 Option 组合），不抢走。
                const target = event.composedPath()[0] as Element | undefined;
                if (!event.ctrlKey && !event.metaKey && target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
                event.preventDefault(); event.stopPropagation();
                const enable = !owner.getState().enabled;
                // 上一次可能已临时改用关键词方式；重新开启时按设置再试一次。
                if (enable) owner.updatePreferences(preference);
                announce = enable;
                const state = owner.setEnabled(enable);
                if (state.enabled === enable && state.phase !== 'unsupported') ports.notice?.(!enable ? 'off' : preference.mode === 'surprisal-local' ? 'onModel' : 'on');
            }, {capture: true, signal});
            signal.addEventListener('abort', () => {owner.dispose(); if (controller === owner) controller = undefined;}, {once: true});
        },
        unmount,
        getState: () => controller?.getState() ?? idle(),
        setEnabled: enabled => controller?.setEnabled(enabled) ?? idle(),
        retry: () => controller?.retry() ?? idle(),
        updatePreferences(next) {
            const toggled = preference.enabled !== (next?.enabled === true);
            preference = normalizeInformationHighlightPreferences(next); controller?.updatePreferences(preference);
            if (toggled) controller?.setEnabled(preference.enabled);
        },
        // 路由切换结束上一页的临时会话；保存为开启时在新正文上继续。
        routeChanged() {controller?.setEnabled(false); if (preference.enabled) controller?.setEnabled(true);},
    };
}
/** 页面组合根只注入配置和消息端口；正文/译文只读入口与注册表定义集中在此适配器。 */
export function createPageInformationHighlightRuntime(ports: {
    document: Document;
    config: {on: boolean; uiLanguage?: string; informationHighlight: InformationHighlightPreferences};
    send(message: {type: string; text?: string; requestId: string}): Promise<unknown>;
    canToggle?(): boolean;
    translateRange?(range: Range): void;
    notice?(message: InformationHighlightNotice): void;
}): InformationHighlightContentRuntime & {feature: ContentFeatureDefinition} {
    const runtime = createInformationHighlightContentRuntime({document: ports.document, preferences: ports.config.informationHighlight,
        send: ports.send, readTranslationRoot: readVisibleTranslationRoot, canToggle: ports.canToggle,
        translateRange: ports.translateRange && (range => {
            if (ports.canToggle?.() !== false) ports.translateRange?.(range);
        }),
        notice: ports.notice ?? (message => showPageNotice(translate(`informationHighlight.notice.${message}`, normalizeUiLanguage(ports.config.uiLanguage)),
            /^(?:o|model)/u.test(message) ? 'success' : 'error', {key: 'information-highlight'}))});
    return {...runtime, feature: {id: 'information-highlight', isEnabled: () => ports.config.on !== false,
        mount: activation => runtime.mount(activation.signal, activation.isCurrent), unmount: runtime.unmount}};
}

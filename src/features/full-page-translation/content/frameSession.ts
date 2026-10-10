/**
 * @file src/features/full-page-translation/content/frameSession.ts
 * 文件职责：让受支持邮件与正文子页面跟随顶层全文会话，并隔离异步状态读取的过期响应。
 * 主要内容：定义不含凭据的会话快照，校验响应，合并通知的在途读取，按会话标识与恢复版本决定启动、保留或清理子页面翻译。
 * 模块边界：不访问 browser、DOM 或配置存储；可信消息传输和功能挂载由 content composition root 注入。
 */
import {translationLanguageOptions} from '@/src/core/language/catalog';
import type {TranslationScope} from '@/src/core/translation/public';
import type {FullPageTranslationMode} from '@/src/core/config/model';
import type {FullPageTranslationConfigSnapshot} from './translationRequest';

export interface FrameTranslationState {
    enabled: boolean;
    revision: number;
    sessionId: number | null;
    translationConfig?: FullPageTranslationConfigSnapshot;
    fullPageMode?: FullPageTranslationMode;
    scope?: TranslationScope;
}

export function isFrameTranslationState(value: unknown): value is FrameTranslationState {
    if (!value || typeof value !== 'object') return false;
    const state = value as FrameTranslationState;
    if (typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.revision) || state.revision < 0) return false;
    if (state.scope !== undefined && state.scope !== 'content' && state.scope !== 'all') return false;
    if (state.sessionId === null) return true;
    if (!Number.isSafeInteger(state.sessionId) || state.sessionId < 1) return false;
    if (state.fullPageMode !== 'all' && state.fullPageMode !== 'viewport') return false;
    const config = state.translationConfig;
    if (!config || typeof config !== 'object') return false;
    return ['service', 'model', 'sourceLanguage', 'targetLanguage'].every(key => typeof config[key as keyof typeof config] === 'string')
        && ['thinking', 'useCache', 'enableAIContext', 'enableAIMultiSegment'].every(key => typeof config[key as keyof typeof config] === 'boolean')
        && (config.displayMode === 'bilingual' || config.displayMode === 'single') && Number.isFinite(config.style)
        && (config.excludedLanguages === undefined || (Array.isArray(config.excludedLanguages)
            && config.excludedLanguages.length <= translationLanguageOptions.length
            && Array.from(config.excludedLanguages).every(language => typeof language === 'string' && language.length <= 32)))
        && (config.profileId === undefined || typeof config.profileId === 'string')
        && (config.glossaryRevision === undefined || (typeof config.glossaryRevision === 'string'
            && /^glossary-v1:(?:disabled|[a-f0-9]{64})$/u.test(config.glossaryRevision)))
        && (config.glossaryIds === undefined || config.glossaryIds === null
            || (Array.isArray(config.glossaryIds) && config.glossaryIds.length <= 100
                && Array.from(config.glossaryIds).every(id => typeof id === 'string' && id.length <= 128)))
        && (config.requestOverridesApplied === undefined || config.requestOverridesApplied === true);
}

export interface FrameSessionDependencies {
    readState(): Promise<unknown>;
    isEnabled(): boolean;
    setAvailable(available: boolean): void;
    start(state: FrameTranslationState): void;
    restore(): void;
}

/** 后台消息本身无法中止，但暂停时应立即释放本页的等待与 abort 监听。 */
function readUntilCancelled(read: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: unknown): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', cancel);
            resolve(value);
        };
        const cancel = (): void => finish(null);
        signal.addEventListener('abort', cancel, {once: true});
        Promise.resolve(read).then(finish, () => finish(null));
        if (signal.aborted) cancel();
    });
}

/** 通知合并后补读顶层真值；暂停前的读取不阻塞新激活，过期响应永远不能重新启动会话。 */
export function createFrameSessionController(deps: FrameSessionDependencies) {
    let generation = 0;
    let disposed = false;
    let sessionId: number | null = null;
    let revision: number | null = null;
    type RefreshBatch = {dirty: boolean; promise: Promise<void>; controller: AbortController};
    let pending: RefreshBatch | null = null;
    const cancelPending = (): void => {
        const previous = pending;
        pending = null;
        previous?.controller.abort();
    };
    const clear = () => { sessionId = null; revision = null; deps.setAvailable(false); deps.restore(); };
    const drain = async (batch: RefreshBatch): Promise<void> => {
        const ownsBatch = () => !disposed && pending === batch;
        try {
            while (ownsBatch()) {
                batch.dirty = false;
                const request = generation;
                let state: unknown;
                try { state = await readUntilCancelled(deps.readState(), batch.controller.signal); } catch { state = null; }
                if (!ownsBatch()) return;
                // 在途通知使旧快照失去提交权，只用一次补读处理整批变化。
                if (batch.dirty || request !== generation) continue;
                const enabled = deps.isEnabled();
                if (!ownsBatch()) return;
                if (request !== generation) continue;
                if (!enabled || !isFrameTranslationState(state) || !state.enabled) { clear(); return; }
                deps.setAvailable(true);
                if (!ownsBatch()) return;
                if (request !== generation) continue;
                if (sessionId === state.sessionId && revision === state.revision) return;
                deps.restore();
                // 挂载或恢复 DOM 可能同步触发配置变化/暂停，不能提交旧会话。
                if (!ownsBatch()) return;
                if (request !== generation) continue;
                sessionId = state.sessionId;
                revision = state.revision;
                if (state.sessionId !== null) deps.start(state);
                if (request === generation) return;
            }
        } finally {
            if (pending === batch) pending = null;
        }
    };
    return {
        async refresh(): Promise<void> {
            if (disposed) return;
            ++generation;
            const enabled = deps.isEnabled();
            if (disposed) return;
            if (!enabled) { cancelPending(); clear(); return; }
            if (pending) { pending.dirty = true; return pending.promise; }
            const batch: RefreshBatch = {dirty: false, promise: Promise.resolve(), controller: new AbortController()};
            pending = batch;
            batch.promise = Promise.resolve().then(() => drain(batch));
            return batch.promise;
        },
        suspend(): void { if (!disposed) { ++generation; cancelPending(); clear(); } },
        dispose(): void { if (!disposed) { disposed = true; ++generation; cancelPending(); clear(); } },
    };
}

/**
 * @file src/services/translation/availability.ts
 * 文件职责：把全局翻译开关接入共享翻译入口，关闭时拒绝新请求并取消所有在途请求。
 * 主要内容：在等待前复制请求字段与可编辑数组，等待配置水合、订阅启停状态、合并调用者取消信号，按启用代次隔离请求所有权，保留消息上的内部快照与预算；水合失败在无请求时记录不含配置的诊断，后续请求仍收到原始错误。
 * 模块边界：只组合注入的配置和翻译端口，不访问浏览器、不改写用户设置，也不清除已完成译文或缓存。
 */
import type {TranslationBroker, TranslationRequestMessage} from './types';
import {attachTranslationRequestControl, createTranslationRequestSnapshot, getTranslationRequestControl} from './requestSnapshot';
import {TRANSLATION_REQUEST_CONTROL} from './types';
import {DEFAULT_PROVIDER_TIMEOUT_MS, getExplicitTranslationBudget, startTranslationRequest,
    TranslationProviderDeadlineError} from './requestDeadline';

interface AvailabilityDependencies {
    ready: Promise<unknown>;
    getConfig(): {on: boolean};
    subscribe(listener: (config: {on: boolean}) => void): () => void;
    translate: TranslationBroker['translateWithCache'];
}

export class TranslationDisabledError extends Error {
    readonly retryable = false;
    readonly code = 'TRANSLATION_DISABLED';
    constructor() {
        super('插件已关闭，请在通用设置中启动插件。');
        this.name = 'TranslationDisabledError';
    }
}

/** 每个应用运行时持有一个订阅；关闭再开启不会恢复旧请求或加入旧的在途去重组。 */
export function createTranslationAvailability(deps: AvailabilityDependencies) {
    let generation = 0;
    let epoch = new AbortController();
    const apply = ({on}: {on: boolean}) => {
        if (!on) epoch.abort();
        else if (epoch.signal.aborted) {
            generation += 1;
            epoch = new AbortController();
        }
    };
    const ready = deps.ready.then(() => {
        deps.subscribe(apply);
        apply(deps.getConfig());
    });
    // 启动时可能还没有翻译请求监听 ready；记录不含配置的诊断，保留原拒绝供后续调用者读取。
    void ready.catch(() => {
        try {console.error('[FluentRead] translation availability initialization failed; check configuration storage.');}
        catch { /* 诊断端口失效不再派生未处理拒绝。 */ }
    });

    async function translateWithCache(message: TranslationRequestMessage): Promise<string | string[]> {
        message = createTranslationRequestSnapshot(message);
        const startedAt = startTranslationRequest(message, Date.now);
        const hydrationDeadline = startedAt + (getExplicitTranslationBudget(message) ?? DEFAULT_PROVIDER_TIMEOUT_MS);
        const owner = getTranslationRequestControl(message);
        const controller = new AbortController();
        let globalSignal: AbortSignal | undefined;
        let deadlineError: TranslationProviderDeadlineError | undefined;
        const abort = () => controller.abort();
        const failure = () => deadlineError ?? (globalSignal?.aborted
            ? new TranslationDisabledError()
            : new DOMException('翻译已取消', 'AbortError'));
        if (owner?.signal.aborted) throw failure();
        owner?.signal.addEventListener('abort', abort, {once: true});
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => reject(failure());
            controller.signal.addEventListener('abort', onAbort, {once: true});
        });
        const timer = setTimeout(() => {
            deadlineError = new TranslationProviderDeadlineError();
            controller.abort();
        }, Math.max(0, hydrationDeadline - Date.now()));
        try {
            // 配置水合也是请求等待的一部分；取消不应等存储完成，迟到水合不能重新派发。
            const work = (async () => {
                await ready;
                clearTimeout(timer);
                if (controller.signal.aborted) throw failure();
                if (Date.now() >= hydrationDeadline) throw new TranslationProviderDeadlineError();
                apply(deps.getConfig());
                globalSignal = epoch.signal;
                if (globalSignal.aborted) throw new TranslationDisabledError();
                globalSignal.addEventListener('abort', abort, {once: true});

                // 展开运算符会丢失不可枚举的预算/快照 symbol；复制描述符并只替换取消控制。
                const descriptors = Object.getOwnPropertyDescriptors(message);
                Reflect.deleteProperty(descriptors, TRANSLATION_REQUEST_CONTROL);
                const request = attachTranslationRequestControl(Object.defineProperties({}, descriptors) as TranslationRequestMessage, {
                    signal: controller.signal,
                    ownershipKey: `${owner?.ownershipKey ?? 'shared'}|global:${generation}`,
                });
                return Promise.resolve().then(() => {
                    if (controller.signal.aborted) throw failure();
                    return deps.translate(request);
                });
            })();
            return await Promise.race([work, cancelled]);
        } finally {
            clearTimeout(timer);
            globalSignal?.removeEventListener('abort', abort);
            owner?.signal.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }
    return {ready, translateWithCache};
}

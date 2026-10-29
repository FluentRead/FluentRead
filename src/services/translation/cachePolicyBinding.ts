/**
 * @file src/services/translation/cachePolicyBinding.ts
 * 文件职责：将已水合的持久配置连接到翻译缓存阈值，保证启动与配置变更使用同一容量策略。
 * 主要内容：等待配置就绪后同步应用内存阈值并在后台维护持久层，订阅上限变化、去重无关通知，提供管理界面可等待且失败可重试的维护入口。
 * 模块边界：只编排注入的配置和缓存端口，不直接读写浏览器存储、不访问 IndexedDB，也不依赖设置页面。
 */
import {normalizeTranslationCacheLimits, type TranslationCacheLimits} from '@/src/core/config/translationCache';

interface CachePolicyConfig {
    translationCacheMaxBytes: number;
    translationCacheMaxEntries: number;
}

interface CachePolicyDependencies {
    ready: Promise<unknown>;
    getConfig(): CachePolicyConfig;
    subscribe(listener: (config: CachePolicyConfig) => void): () => void;
    setLimits(limits: TranslationCacheLimits): Promise<void>;
    warn(error: unknown): void;
}

/** 后台生命周期内维持一个订阅；配置恢复与外部同步同样立即应用阈值。 */
export function createTranslationCachePolicyBinding(deps: CachePolicyDependencies) {
    let requested = '';
    let maintenance: Promise<void> = Promise.resolve();

    function apply(config: CachePolicyConfig): Promise<void> {
        const limits = normalizeTranslationCacheLimits({
            maxBytes: config.translationCacheMaxBytes,
            maxEntries: config.translationCacheMaxEntries,
        });
        const signature = `${limits.maxBytes}:${limits.maxEntries}`;
        if (signature === requested) return maintenance;
        requested = signature;
        const operation: Promise<void> = deps.setLimits(limits).catch((error: unknown) => {
            // 配置可从 A 切到 B 再切回 A；只允许当前操作重置去重标记。
            if (maintenance === operation) requested = '';
            throw error;
        });
        maintenance = operation;
        // 每次维护只旁路告警一次；保留拒绝状态供管理请求重试，启动与配置订阅不用等待存储。
        void maintenance.catch(deps.warn);
        return maintenance;
    }

    const ready = deps.ready.then(() => {
        deps.subscribe((config) => { void apply(config); });
        // setLimits 在第一个 await 前同步更新内存上限；IndexedDB 打开或升级被阻塞时，
        // 翻译仍可继续，尤其不能让已关闭缓存的请求等待无关的持久层清理。
        void apply(deps.getConfig());
    }).catch(deps.warn);

    return {
        ready,
        async applyLatest(): Promise<void> {
            await ready;
            await apply(deps.getConfig());
        },
    };
}

/**
 * @file src/features/settings/ui/services/freeTranslationChecks.ts
 * 文件职责：编排设置页免费翻译全目录检查及逐服务展示状态。
 * 主要内容：对全部候选限并发检查，独立保留成功、失败和耗时；通过代次检查阻止切换页面后的排队请求与迟到结果。
 * 模块边界：不调用浏览器或供应商、不修改启用列表与运行时健康；配置保存、消息超时和 UI 更新由调用方注入。
 */
import {FREE_TRANSLATION_PROVIDERS, type FreeTranslationProviderId} from '@/src/core/config/freeTranslation';

export type FreeTranslationCheckState = {
    status: 'idle' | 'queued' | 'checking' | 'success' | 'error';
    durationMs?: number;
    error?: string;
};
export type FreeTranslationChecks = Partial<Record<FreeTranslationProviderId, FreeTranslationCheckState>>;

export async function checkAllFreeTranslationProviders(options: {
    check: (providerId: FreeTranslationProviderId) => Promise<{success?: boolean; durationMs?: number; error?: string} | undefined>;
    update: (providerId: FreeTranslationProviderId, state: FreeTranslationCheckState) => void;
    isCurrent: () => boolean;
    failureMessage: string;
    now?: () => number;
}): Promise<void> {
    let next = 0;
    const now = options.now ?? (() => performance.now());
    for (const provider of FREE_TRANSLATION_PROVIDERS) options.update(provider.id, {status: 'queued'});
    async function worker(): Promise<void> {
        while (options.isCurrent()) {
            const provider = FREE_TRANSLATION_PROVIDERS[next++];
            if (!provider) return;
            options.update(provider.id, {status: 'checking'});
            const startedAt = now();
            const elapsed = () => Math.max(0, Math.round(now() - startedAt));
            try {
                const result = await options.check(provider.id);
                if (!options.isCurrent()) return;
                const durationMs = typeof result?.durationMs === 'number' && Number.isFinite(result.durationMs) && result.durationMs >= 0
                    ? Math.round(result.durationMs) : elapsed();
                options.update(provider.id, result?.success === true
                    ? {status: 'success', durationMs}
                    : {status: 'error', durationMs, error: result?.error || options.failureMessage});
            } catch (error) {
                if (!options.isCurrent()) return;
                options.update(provider.id, {status: 'error', durationMs: elapsed(), error: error instanceof Error ? error.message : String(error)});
            }
        }
    }
    await Promise.all(Array.from({length: 3}, worker));
}

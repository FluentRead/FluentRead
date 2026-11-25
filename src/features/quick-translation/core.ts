/**
 * @file src/features/quick-translation/core.ts
 * 文件职责：把已归一化的快捷翻译方案解析为一次不可变的页面翻译调用配置。
 * 主要内容：合并方案与全局默认服务、模型、目标语言、页面识别范围和全文加载范围；显示方式只传递显式覆盖，让跟随默认的译文继续响应全局显示切换，供内容脚本手势路由复用。
 * 模块边界：本文件只做纯数据解析，不监听事件、不读取存储、不执行翻译，也不持有 DOM 状态。
 */
import {resolveConfiguredModel} from '@/src/core/config/catalog';
import type {Config} from '@/src/core/config/model';
import type {QuickTranslationProfile} from '@/src/core/config/quickTranslation';
import type {PageTranslationInvocation} from '@/src/features/full-page-translation/public';

type QuickTranslationConfigSource = Pick<
    Config,
    'service' | 'model' | 'customModel' | 'to' | 'display' | 'fullPageTranslationMode' | 'translationScope'
>;

/** 按下快捷键时冻结请求身份；默认显示方式由翻译入口捕获，保留后续全局呈现切换。 */
export function resolveQuickTranslationInvocation(
    profile: QuickTranslationProfile,
    config: QuickTranslationConfigSource,
): PageTranslationInvocation {
    const service = profile.service || config.service;
    const model = profile.model || resolveConfiguredModel(
        config.model[service],
        config.customModel[service],
    );
    const displayMode = profile.displayMode === 'bilingual'
        ? 'bilingual'
        : profile.displayMode === 'translation-only' ? 'single' : undefined;
    return {
        ...(profile.glossaryIds !== undefined ? {glossaryIds: profile.glossaryIds ? [...profile.glossaryIds] : null} : {}),
        profileId: profile.id,
        scope: config.translationScope,
        service,
        ...(model ? {model} : {}),
        targetLanguage: profile.targetLanguage || config.to,
        ...(displayMode ? {displayMode} : {}),
        ...(profile.action === 'full-page'
            ? {fullPageMode: profile.fullPageMode === 'inherit'
                ? config.fullPageTranslationMode
                : profile.fullPageMode}
            : {}),
    };
}

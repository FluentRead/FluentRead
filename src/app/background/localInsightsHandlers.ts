/**
 * @file src/app/background/localInsightsHandlers.ts
 * 文件职责：集中组装设置页读取本机统计的后台消息处理器，让模型用量与翻译统计共享同一个设置页来源校验。
 * 主要内容：把模型用量仓库与翻译统计仓库分别注入对应 handler，并以数组形式交给后台静态消息 registry。
 * 模块边界：本文件属于后台 composition root，只负责依赖接线；参数校验位于 handlers，聚合与持久化位于 services 和 platform/storage。
 */
import {modelUsageRepository} from '@/src/platform/storage/modelUsageRepository';
import {translationStatsRepository} from '@/src/platform/storage/translationStatsRepository';
import type {BackgroundMessageHandler} from './messageRouter';
import type {ConfigPersistenceContext} from './handlers/configPersistence';
import {createModelUsageHandler} from './handlers/modelUsage';
import {createTranslationStatsHandler} from './handlers/translationStats';

/** 两类统计都只允许扩展设置页读取或清除。 */
export function createLocalInsightsHandlers<TContext extends ConfigPersistenceContext>(
    isOptionsUrl: (url: string) => boolean,
): Array<BackgroundMessageHandler<TContext>> {
    return [
        createModelUsageHandler(modelUsageRepository, isOptionsUrl),
        createTranslationStatsHandler(translationStatsRepository, isOptionsUrl),
    ] as Array<BackgroundMessageHandler<TContext>>;
}

/**
 * @file src/core/config/model/modelMigration.ts
 *
 * 文件职责：维护已退役或历史官方预设模型编号到当前官方模型编号的映射表与安全迁移函数。
 * 主要内容：导出 migrateModelIdentifier 与 migrateModelIdentifiers，仅迁移已登记的自有服务和自有旧编号，拒绝继承原型属性并保持私有部署别名原样不变。
 * 模块边界：仅依赖 catalog/services、catalog/models 与 ./clone，使请求模板和端点解析器可以独立复用模型迁移而不依赖整个 Config 类或 normalizeConfig。
 */

import {currentModelIds, defaultModelIds} from '../catalog/models';
import {services} from '../catalog/services';
import {hasOwn} from './clone';
import type {IMapping} from './types';

const modelMigrations: Record<string, Record<string, string>> = {
    [services.openai]: {
        gpt5: currentModelIds.openai,
    },
    [services.zhipu]: {
        'glm-4.5': currentModelIds.zhipu,
        'GLM-4-Flash': currentModelIds.zhipuFlash,
        'glm-4-plus': currentModelIds.zhipu,
        'glm-4': currentModelIds.zhipu,
        'glm-4v': currentModelIds.zhipu,
    },
    [services.moonshot]: {
        'kimi-k2-0711-preview': currentModelIds.moonshot,
        'kimi-k2-turbo-preview': currentModelIds.moonshot,
        'moonshot-v1-auto': currentModelIds.moonshot,
        'moonshot-v1-8k': currentModelIds.moonshot,
        'moonshot-v1-32k': currentModelIds.moonshot,
    },
    [services.claude]: {
        'claude-sonnet-4-0': currentModelIds.claudeSonnet,
        'claude-opus-4-1': currentModelIds.claudeOpus,
        'claude-3-5-sonnet': currentModelIds.claudeSonnet,
        'claude-3-5-sonnet-20241022': currentModelIds.claudeSonnet,
        'claude-3-opus': currentModelIds.claudeOpus,
        'claude-3-opus-20240229': currentModelIds.claudeOpus,
        'claude-3-5-haiku': currentModelIds.claudeHaiku,
        'claude-3-5-haiku-20241022': currentModelIds.claudeHaiku,
        'claude-3-5-haiku-latest': currentModelIds.claudeHaiku,
    },
    [services.grok]: {
        'grok-4-0709': currentModelIds.grok,
    },
    [services.groq]: {
        'llama-3.3-70b-versatile': currentModelIds.groqLarge,
        'llama-3.1-8b-instant': currentModelIds.groqSmall,
        'llama3-8b-8192': currentModelIds.groqSmall,
    },
    [services.yiyan]: {
        'ERNIE-Bot 4.0': currentModelIds.yiyan,
        'ERNIE-Bot': currentModelIds.yiyan,
        'ERNIE-Speed-8K': currentModelIds.yiyanFast,
    },
    [services.minimax]: {
        chatcompletion_v2: currentModelIds.minimax,
        'MiniMax-Text-01': currentModelIds.minimax,
        'MiniMax-M3.1': 'MiniMax-M3.1-flash',
    },
    [services.mimo]: {
        // 官方将在 2026-10-21 直接停用旧编号；网页、文档和模型级偏好使用同一映射。
        'mimo-v2.5-pro': currentModelIds.mimo,
        'mimo-v2.5': defaultModelIds[services.mimo],
    },
    [services.jieyue]: {
        'step-1-8k': currentModelIds.jieyue,
    },
    [services.huanYuan]: {
        // 官方已于 2026-08-31 下线预览版，迁移到正式版并复用模型级偏好迁移。
        'hy3-preview': 'hy3',
        'hunyuan-turbos-latest': currentModelIds.huanYuan,
        'hunyuan-t1-latest': currentModelIds.huanYuan,
        'hunyuan-a13b': currentModelIds.huanYuan,
        'hunyuan-lite': currentModelIds.huanYuan,
        'hunyuan-standard': currentModelIds.huanYuan,
    },
    [services.infini]: {
        'llama-2-13b-chat': currentModelIds.infiniGeneral,
        'llama-3.3-70b-instruct': currentModelIds.infiniGeneral,
        'qwen2.5-14b-instruct': currentModelIds.infiniGeneral,
        'gemma-2-27b-it': currentModelIds.infiniGeneral,
        'glm-4-9b-chat': currentModelIds.infiniZhipu,
    },
};

/**
 * 将单个官方预设的旧编号映射到当前编号，供配置加载与请求模板共同兜底。
 * 自定义模型应由调用方跳过此函数，以免改写私有部署别名。
 */
export function migrateModelIdentifier(service: string, selectedModel: string): string {
    const migrations = hasOwn(modelMigrations, service) ? modelMigrations[service] : undefined;
    return migrations && hasOwn(migrations, selectedModel) ? migrations[selectedModel] : selectedModel;
}

export function migrateModelIdentifiers(configuredModels: IMapping): void {
    for (const service of Object.keys(modelMigrations)) {
        const selectedModel = configuredModels[service];
        if (!selectedModel) continue;
        configuredModels[service] = migrateModelIdentifier(service, selectedModel);
    }
}

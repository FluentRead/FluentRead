/**
 * @file src/core/config/privateTranslation.ts
 * 文件职责：定义可选的无痕共享翻译服务与模型配置，保持禁用默认值和不可用选择的失败语义。
 * 主要内容：归一化开关与有界字符串，保留被删除的服务编号供运行时明确拒绝，不静默继承普通翻译。
 * 模块边界：纯配置规则，不读取浏览器身份、凭据、存储或调用供应商。
 */
import {services} from './catalog';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider} from './customOpenAI';

export interface PrivateTranslationConfig {
    enabled: boolean;
    service: string;
    model: string;
}

export function normalizePrivateTranslation(value: unknown): PrivateTranslationConfig {
    const source = value && typeof value === 'object' ? value as Partial<PrivateTranslationConfig> : {};
    return {
        enabled: source.enabled === true,
        service: typeof source.service === 'string' && source.service.trim().length <= 128 ? source.service.trim() : '',
        model: typeof source.model === 'string' && source.model.trim().length <= 256 ? source.model.trim() : '',
    };
}

export function supportsPrivateTranslationService(service: string, providers: readonly CustomOpenAIProvider[] | undefined): boolean {
    return service === services.openai
        || (isCustomOpenAIProviderId(service) && isConfiguredCustomOpenAIProvider(providers, service));
}

/**
 * @file src/core/config/translationPreflight.ts
 * 文件职责：按显式配置和本次调用覆盖判断页面翻译能否启动，保持配置政策独立于页面通知与全局存储。
 * 主要内容：检查启停与必需模型，返回可区分的拒绝原因；快捷方案沿用本次服务和模型。
 * 模块边界：仅消费传入数据与静态服务目录，不读取配置、不访问 DOM、不显示通知、不发起请求。
 */
import {customModelString, servicesType} from './catalog';

export interface TranslationConfigCheckOptions {
    service?: string;
    model?: string;
    displayMode?: 'bilingual' | 'single';
}

export interface TranslationPreflightConfig {
    on?: boolean;
    service: string;
    model: Readonly<Record<string, string>>;
    customModel: Readonly<Record<string, string>>;
    display: number;
}

export type TranslationPreflightResult = {allowed: true} | {
    allowed: false;
    reason: 'disabled' | 'missing-model';
};

export function resolveTranslationPreflight(current: TranslationPreflightConfig, options: TranslationConfigCheckOptions = {}): TranslationPreflightResult {
    if (!current.on) return {allowed: false, reason: 'disabled'};
    const service = options.service?.trim() || current.service;
    const explicitModel = options.model?.trim();
    if (servicesType.isUseModel(service)) {
        const configuredModel = current.model[service];
        const customModel = current.customModel[service];
        const model = explicitModel || (configuredModel === customModelString ? customModel : configuredModel);
        if (!model || (!explicitModel && configuredModel === customModelString && !customModel)) {
            return {allowed: false, reason: 'missing-model'};
        }
    }
    return {allowed: true};
}

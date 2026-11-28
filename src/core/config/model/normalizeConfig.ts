/**
 * @file src/core/config/model/normalizeConfig.ts
 *
 * 文件职责：实现顶层配置归一化入口 normalizeConfig，将存储或导入的任意普通对象补齐、清洗并迁移为合法的 Config 实例。
 * 主要内容：调用迭代深克隆剥离响应式 Proxy 与敏感未知键，剔除退役与存储协议内部字段，按依赖顺序编排供应商与限流、阅读外观与术语库、视频媒体与输入框快捷键四个领域子归一化管线。
 * 模块边界：协调 configClass 与各领域配置子模块的纯转换管线，不直接读写浏览器存储或发起网络请求。
 */

import {isSensitiveConfigKey} from '../sensitiveKeys';
import {cloneConfigValue} from './clone';
import {Config} from './configClass';
import {normalizeAppearanceAndReadingConfig} from './normalizeAppearanceAndReading';
import {normalizeInputAndShortcutsConfig} from './normalizeInputAndShortcuts';
import {normalizeProvidersAndLimitsConfig} from './normalizeProvidersAndLimits';
import {normalizeVideoAndMediaConfig} from './normalizeVideoAndMedia';

const RETIRED_OR_INTERNAL_CONFIG_KEYS = [
    // 短期版本曾暴露的策略开关在对应功能退役后必须主动丢弃，避免旧配置继续
    // 分叉存储语义，或让已经删除的 X 原生翻译设置进入历史和迁移导出。
    'persistCredentials',
    'xGrokAutoTranslateEnabled',
    'translationStatus',
    // __fluentConfigRevision 只用于 storage 的写入顺序判断，不能进入运行时
    // 配置或历史快照，否则默认配置与同值的页面快照会因内部字段不同而无法去重。
    '__fluentConfigRevision',
    // 后台计数幂等日志与 revision 一样只属于存储协议，不能进入 UI、历史或导出配置。
    '__fluentCountOperations',
    'robot_id',
] as const;

/**
 * 将存储或导入的普通对象补齐为当前配置结构，并迁移已退役或错误的模型编号。
 */
export function normalizeConfig(value: unknown): Config {
    const normalized = new Config();
    const knownFields = new Set(Object.keys(normalized));
    // Vue 的响应式对象是 Proxy。Chrome 的 runtime 通道有时会替调用方
    // 做隐式转换，但 Firefox 会严格按 structured clone 处理并直接抛出
    // DataCloneError，所以配置边界必须先落成纯对象。
    const source = value && typeof value === 'object'
        ? cloneConfigValue(value) as Partial<Config>
        : {};
    // 导入对象的所有键都是普通数据；避免 __proto__ setter 改写配置实例的原型。
    for (const key of Object.keys(source)) {
        Object.defineProperty(normalized, key, Object.getOwnPropertyDescriptor(source, key)!);
    }
    const normalizedRecord = normalized as unknown as Record<string, unknown>;
    for (const retiredKey of RETIRED_OR_INTERNAL_CONFIG_KEYS) {
        delete normalizedRecord[retiredKey];
    }
    for (const key of Object.keys(source)) {
        if (!knownFields.has(key) && isSensitiveConfigKey(key)) {
            delete normalizedRecord[key];
        }
    }

    // 翻译次数只接受非负安全整数；旧版本或手工修改产生的字符串、负数和溢出值回退为 0。
    normalized.count = typeof source.count === 'number'
        && Number.isSafeInteger(source.count)
        && source.count >= 0
        ? source.count
        : 0;

    // 顺序不可随意调换：供应商服务先于阅读/视频/快捷方案，术语库与视频快捷键先于快捷方案保留键校验。
    normalizeProvidersAndLimitsConfig(normalized, source);
    normalizeAppearanceAndReadingConfig(normalized, source);
    normalizeVideoAndMediaConfig(normalized, source);
    normalizeInputAndShortcutsConfig(normalized, source);
    return normalized;
}

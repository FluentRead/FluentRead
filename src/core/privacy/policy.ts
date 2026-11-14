/**
 * @file src/core/privacy/policy.ts
 * 文件职责：定义翻译隐私防护的配置、容量边界和稳定失败类型。
 * 主要内容：归一化类别与阻止/脱敏模式，限制自定义字面词条规模；异常只含固定文案，不携带原文或命中值。
 * 模块边界：纯配置规则，不读取存储、不加载模型、不调用网络；敏感词由配置凭据存储单独拥有。
 */
export const PRIVACY_CATEGORIES = ['email', 'phone', 'identity', 'payment', 'secret', 'network'] as const;
export type PrivacyCategory = typeof PRIVACY_CATEGORIES[number];
export interface PrivacyProtectionPolicy {
    enabled: boolean;
    mode: 'mask' | 'block';
    categories: PrivacyCategory[];
}
export const MAX_PRIVACY_TERMS = 128;
export const MAX_PRIVACY_TERM_LENGTH = 256;
export const MAX_PRIVACY_TEXT_LENGTH = 1_000_000;
export const MAX_PRIVACY_MATCHES = 10_000;

export function normalizePrivacyPolicy(value: unknown): PrivacyProtectionPolicy {
    const input = value && typeof value === 'object' ? value as Partial<PrivacyProtectionPolicy> : {};
    return {
        enabled: input.enabled === true,
        mode: input.mode === 'block' ? 'block' : 'mask',
        categories: Array.isArray(input.categories)
            ? PRIVACY_CATEGORIES.filter(category => input.categories!.includes(category))
            : PRIVACY_CATEGORIES.filter(category => category !== 'network'),
    };
}

export function normalizePrivacyTerms(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string')
        .map(item => item.trim()).filter(item => item.length > 0 && item.length <= MAX_PRIVACY_TERM_LENGTH))]
        .slice(0, MAX_PRIVACY_TERMS);
}

const messages = {
    PRIVACY_CONTENT_BLOCKED: '隐私防护发现敏感内容，已阻止发送。可在设置中改为脱敏后翻译。',
    PRIVACY_RESTORE_FAILED: '翻译服务未完整保留隐私标记，已停止展示；不会回退发送原文。',
    PRIVACY_CAPACITY_EXCEEDED: '内容超出隐私防护的处理上限，已阻止发送。请分段后重试。',
    PRIVACY_IMAGE_BLOCKED: '隐私防护无法清除图片中的敏感信息，已阻止发送图片。请改用本地文字识别。',
    PRIVACY_SESSION_UNAVAILABLE: '隐私防护无法建立安全会话，已阻止发送。',
} as const;
export class PrivacyProtectionError extends Error {
    readonly kind = 'bad-request';
    readonly retryable = false;
    constructor(readonly code: keyof typeof messages) {
        super(messages[code]);
        this.name = 'PrivacyProtectionError';
    }
}

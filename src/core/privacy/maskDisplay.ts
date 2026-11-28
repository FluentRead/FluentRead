/**
 * @file src/core/privacy/maskDisplay.ts
 * 文件职责：把命中的敏感片段转换为不可逆、带星号且可辨识的展示摘要，供本地预览与防护记录共用。
 * 主要内容：按邮箱、电话、证件、银行卡/IBAN、密码密钥、IPv4 与自定义敏感词分别生成脱敏形态，确保输出始终包含 `*` 且截断长度有界，绝不暴露密码、验证码或完整敏感值。
 * 模块边界：纯字符串算法，无浏览器存储、网络或统计状态；userscript 仅消费本模块而不引入扩展专属记录与聚合代码。
 */
import type {PrivacyCategory} from './policy';

export type PrivacyMaskedCategory = PrivacyCategory | 'custom';
export const MAX_PRIVACY_MASKED_SAMPLE_LENGTH = 48;

export function cleanPrivacyDisplayText(value: string): string {
    return value
        .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function clampPrivacyMaskedText(value: string): string {
    const chars = Array.from(value);
    if (chars.length <= MAX_PRIVACY_MASKED_SAMPLE_LENGTH) return value;
    return `${chars.slice(0, MAX_PRIVACY_MASKED_SAMPLE_LENGTH - 3).join('')}***`;
}

function maskEmail(clean: string): string {
    const normalized = clean.replace(/＠/gu, '@').replace(/．/gu, '.');
    const at = normalized.lastIndexOf('@');
    if (at <= 0 || at >= normalized.length - 1) return '***@***';
    const localChars = Array.from(normalized.slice(0, at));
    const domain = normalized.slice(at + 1);
    const localMask = localChars.length <= 1 ? '*' : `${localChars[0]}***`;
    const dot = domain.lastIndexOf('.');
    if (dot <= 0 || dot >= domain.length - 1) return `${localMask}@***`;
    const hostChars = Array.from(domain.slice(0, dot));
    const tld = domain.slice(dot);
    return `${localMask}@${hostChars[0]}***${tld}`;
}

function maskPhone(clean: string): string {
    const normalized = clean.replace(/[\uFF01-\uFF5E]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
    const hasPlus = normalized.startsWith('+');
    const digits = normalized.replace(/\D/gu, '');
    if (digits.length >= 7) return `${hasPlus ? '+' : ''}${digits.slice(0, 3)}****${digits.slice(-2)}`;
    if (digits.length >= 4) return `${hasPlus ? '+' : ''}${digits[0]}***${digits.slice(-2)}`;
    return '***';
}

function maskIdentity(clean: string): string {
    if (/^\d{3}-\d{2}-\d{4}$/u.test(clean)) return `***-**-**${clean.slice(-2)}`;
    const chars = Array.from(clean);
    if (chars.length >= 8) return `${chars.slice(0, 3).join('')}***${chars.slice(-2).join('')}`;
    if (chars.length >= 4) return `${chars[0]}***${chars[chars.length - 1]}`;
    return '***';
}

function maskPayment(clean: string): string {
    const compact = clean.replace(/[ -]/gu, '');
    if (/^[A-Za-z]{2}\d{2}/u.test(compact) && compact.length >= 10) {
        return `${compact.slice(0, 4).toUpperCase()} **** ${compact.slice(-2).toUpperCase()}`;
    }
    const digits = compact.replace(/\D/gu, '');
    if (digits.length >= 10) return `**** **** ${digits.slice(-4)}`;
    if (compact.length >= 4) return `****${compact.slice(-2)}`;
    return '****';
}

function maskSecret(clean: string): string {
    if (/^-----BEGIN\s/u.test(clean)) return '-----BEGIN *** KEY-----';
    // 只保留公开的凭据格式前缀，绝不暴露任何随机密钥位、口令或验证码字符。
    const prefix = clean.match(/^(sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|ASIA|eyJ)/u);
    if (prefix) return `${prefix[1]}***`;
    return '******';
}

function maskNetwork(clean: string): string {
    const normalized = clean.replace(/[\uFF01-\uFF5E]/gu, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
    const parts = normalized.split('.');
    if (parts.length === 4 && parts.every(part => /^\d{1,3}$/u.test(part))) {
        return `${parts[0]}.***.***.${parts[3]}`;
    }
    return '***.***.***';
}

function maskCustom(clean: string): string {
    const chars = Array.from(clean);
    if (chars.length <= 1) return '*';
    if (chars.length === 2) return `${chars[0]}*`;
    if (chars.length <= 5) return `${chars[0]}***`;
    return `${chars.slice(0, 2).join('')}***${chars[chars.length - 1]}`;
}

/**
 * 将单次命中的敏感文本转换为不可逆且可辨识的星号摘要。
 * 保证输出始终包含 `*`，用于预览和设置页记录展示，不保留完整敏感值。
 */
export function formatPrivacyMaskedDisplay(value: string, category: PrivacyMaskedCategory): string {
    const clean = cleanPrivacyDisplayText(value);
    if (!clean) return '***';
    let formatted: string;
    switch (category) {
        case 'email':
            formatted = maskEmail(clean);
            break;
        case 'phone':
            formatted = maskPhone(clean);
            break;
        case 'identity':
            formatted = maskIdentity(clean);
            break;
        case 'payment':
            formatted = maskPayment(clean);
            break;
        case 'secret':
            formatted = maskSecret(clean);
            break;
        case 'network':
            formatted = maskNetwork(clean);
            break;
        case 'custom':
            formatted = maskCustom(clean);
            break;
    }
    return clampPrivacyMaskedText(formatted);
}

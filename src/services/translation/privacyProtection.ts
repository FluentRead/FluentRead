/**
 * @file src/services/translation/privacyProtection.ts
 * 文件职责：将本地隐私防护接入统一翻译 provider 边界，覆盖正文、批次、上下文、摘要与自定义提示词。
 * 主要内容：每次调用使用独立会话，文本槽分别校验，敏感词不传递给 provider；图片输入明确拒绝，异常与重试不能绕过脱敏。
 * 模块边界：只转换冻结的请求和配置，不调用网络、不写缓存；broker 负责调度、截止时间、统计及 finally 清理，术语保护在脱敏之后继续执行。
 */
import {createPrivacySession} from '@/src/core/privacy/session';
import {normalizePrivacyPolicy, PrivacyProtectionError} from '@/src/core/privacy/policy';
import {isSensitiveConfigKey} from '@/src/core/config/sensitiveKeys';
import {parseTranslationSlots, serializeTranslationSlots} from '@/src/core/translation/slotProtocol';
import {attachTranslationProviderConfig, getTranslationGlossarySourceSlots, getTranslationImageInput} from './requestSnapshot';
import type {TranslationProviderConfigSnapshot, TranslationRequestMessage} from './types';

export function preparePrivacyRequest<T extends TranslationRequestMessage>(message: T, current: TranslationProviderConfigSnapshot) {
    if (!current.privacyProtection?.enabled) return {message, config: current, restore: (result: unknown) => result, dispose() {}};
    if (getTranslationImageInput(message)) throw new PrivacyProtectionError('PRIVACY_IMAGE_BLOCKED');
    const session = createPrivacySession(normalizePrivacyPolicy(current.privacyProtection), current.privacyProtectionSecretTerms);
    try {
        const summary = 'summaryPrompt' in message && typeof message.summaryPrompt === 'string' && Boolean(message.summaryPrompt.trim());
        const slots = typeof message.origin === 'string' ? getTranslationGlossarySourceSlots(message.origin) : undefined;
        const sources = slots?.texts ?? (Array.isArray(message.origin) ? message.origin : [message.origin]);
        const packets = sources.map(text => session.mask(text));
        const nonce = slots?.packet.starts[0].slice('___FLUENTREAD_'.length, -'_0_BEGIN___'.length);
        const origin = slots ? serializeTranslationSlots(packets.map(packet => packet.text), nonce).payload
            : Array.isArray(message.origin) ? packets.map(packet => packet.text) : packets[0].text;
        const sanitized = {...message, origin} as T;
        // 所有可进入提示词的数据字段都按同一映射处理，不扫描语言/模型标识或认证头。
        const fields = ['context', 'pageContext', 'discourseContext', 'subtitleContext', 'sourceLanguageDetectionText', 'summaryPrompt', 'summarySystemPrompt'] as const;
        for (const key of fields) {
            const value = (message as unknown as Record<string, unknown>)[key];
            if (typeof value === 'string') (sanitized as unknown as Record<string, unknown>)[key] = session.mask(value).text;
        }
        const service = message.serviceOverride || current.service;
        // 只处理实际服务的模板。其他服务的私密提示词既不需要扫描，也不能触发本次阻止模式。
        const maskMap = (mapping: Record<string, string>, transform = (value: string) => session.mask(value).text) =>
            Object.freeze({[service]: mapping[service] ? transform(mapping[service]) : ''});
        const maskBody = (value: string) => {
            let body: unknown;
            try {body = JSON.parse(value);} catch {return session.mask(value).text;}
            // JSON 转义必须先解码；对有明确秘密语义的键保护完整值，包括空格与引号。
            return JSON.stringify(body, (key, field) => {
                const secret = current.privacyProtection!.categories.includes('secret')
                    && (isSensitiveConfigKey(key) || /^(?:otp|验证码|密码|密钥)$/u.test(key));
                return typeof field === 'string' || secret && typeof field === 'number'
                    ? session.mask(String(field), secret ? 'secret' : undefined).text : field;
            });
        };
        const config = Object.freeze({...current,
            system_role: maskMap(current.system_role), user_role: maskMap(current.user_role),
            customBody: maskMap(current.customBody, maskBody),
            privacyProtectionSecretTerms: Object.freeze([]),
            glossaryProtectedTokens: Object.freeze([...(current.glossaryProtectedTokens ?? []), ...session.tokens]),
        });
        return {
            message: attachTranslationProviderConfig(sanitized, config), config,
            restore(result: unknown): unknown {
                if (slots) {
                    const outputs = typeof result === 'string' ? parseTranslationSlots(slots.packet, result) : null;
                    if (!outputs) throw new PrivacyProtectionError('PRIVACY_RESTORE_FAILED');
                    return serializeTranslationSlots(outputs.map((text, index) => session.restore(text, packets[index])), nonce).payload;
                }
                if (!Array.isArray(message.origin)) return session.restore(result, packets[0], summary);
                if (!Array.isArray(result) || result.length !== packets.length) throw new PrivacyProtectionError('PRIVACY_RESTORE_FAILED');
                return result.map((text, index) => session.restore(text, packets[index]));
            },
            dispose: session.dispose,
        };
    } catch (error) {session.dispose(); throw error;}
}

/**
 * @file src/core/privacy/session.ts
 * 文件职责：为一次翻译建立本地脱敏映射，并严格校验译文后恢复敏感值。
 * 主要内容：使用随机请求命名空间和稳定值映射，逐槽限制标记集合及次数；摘要允许省略标记，但不能借用其他槽或凭空生成标记；结束后清理映射。
 * 模块边界：映射仅在调用栈内存中存在，不序列化、不写日志、不发送网络；JavaScript 字符串由 GC 回收，不声称物理内存擦除。
 */
import {createPrivacyDetector, type PrivacySpan} from './detect';
import {MAX_PRIVACY_MATCHES, MAX_PRIVACY_TEXT_LENGTH, PrivacyProtectionError, type PrivacyProtectionPolicy} from './policy';

export interface PrivacyPacket {
    readonly text: string;
    readonly spans: readonly PrivacySpan[];
    readonly expected: ReadonlyMap<string, number>;
}

export function createPrivacySession(policy: PrivacyProtectionPolicy, terms: readonly string[] = []) {
    const detect = createPrivacyDetector(policy, terms);
    const values = new Map<string, string>();
    const originals = new Map<string, string>();
    let prefix = '';
    let processed = 0;
    let disposed = false;
    function assertLive() {
        if (disposed) throw new PrivacyProtectionError('PRIVACY_SESSION_UNAVAILABLE');
    }
    function tokenFor(value: string): string {
        const known = originals.get(value);
        if (known) return known;
        if (values.size >= MAX_PRIVACY_MATCHES) throw new PrivacyProtectionError('PRIVACY_CAPACITY_EXCEEDED');
        if (!prefix) {
            try {
                const random = crypto.getRandomValues(new Uint8Array(12));
                // A–P 编码避免随机数字本身被二次电话识别，也不泄漏敏感类别或长度。
                prefix = '__FRP_' + Array.from(random, byte => String.fromCharCode(65 + (byte >> 4), 65 + (byte & 15))).join('') + '_';
            } catch {throw new PrivacyProtectionError('PRIVACY_SESSION_UNAVAILABLE');}
        }
        const token = `${prefix}${values.size.toString(36).toUpperCase()}__`;
        originals.set(value, token);
        values.set(token, value);
        return token;
    }
    return {
        mask(text: string, explicitCategory?: PrivacySpan['category']): PrivacyPacket {
            assertLive();
            processed += text.length;
            if (processed > MAX_PRIVACY_TEXT_LENGTH * 4) throw new PrivacyProtectionError('PRIVACY_CAPACITY_EXCEEDED');
            if (text.length > MAX_PRIVACY_TEXT_LENGTH) throw new PrivacyProtectionError('PRIVACY_CAPACITY_EXCEEDED');
            const spans = explicitCategory && text ? [{start: 0, end: text.length, category: explicitCategory}] : detect(text);
            if (spans.length && policy.mode === 'block') throw new PrivacyProtectionError('PRIVACY_CONTENT_BLOCKED');
            const expected = new Map<string, number>();
            if (!spans.length) return {text, spans, expected};
            const parts: string[] = [];
            let offset = 0;
            for (const span of spans) {
                const token = tokenFor(text.slice(span.start, span.end));
                parts.push(text.slice(offset, span.start), token);
                expected.set(token, (expected.get(token) ?? 0) + 1);
                offset = span.end;
            }
            if (text.includes(prefix)) throw new PrivacyProtectionError('PRIVACY_SESSION_UNAVAILABLE');
            parts.push(text.slice(offset));
            return {text: parts.join(''), spans, expected};
        },
        get tokens(): readonly string[] {return [...values.keys()];},
        restore(result: unknown, packet: PrivacyPacket, allowMissing = false): string {
            assertLive();
            if (typeof result !== 'string') throw new PrivacyProtectionError('PRIVACY_RESTORE_FAILED');
            if (!prefix) return result;
            const counts = new Map<string, number>();
            const pattern = new RegExp(`${prefix}[A-Z0-9]+__`, 'gu');
            let lastEnd = 0;
            const parts: string[] = [];
            for (const match of result.matchAll(pattern)) {
                const token = match[0];
                const count = (counts.get(token) ?? 0) + 1;
                if (!packet.expected.has(token) || count > packet.expected.get(token)!) throw new PrivacyProtectionError('PRIVACY_RESTORE_FAILED');
                counts.set(token, count);
                parts.push(result.slice(lastEnd, match.index), values.get(token)!);
                lastEnd = match.index + token.length;
            }
            // 已有命名空间的残片、大小写破坏和未知序号都必须显式失败。
            if (result.replace(pattern, '').toUpperCase().includes(prefix.slice(6, -1))) throw new PrivacyProtectionError('PRIVACY_RESTORE_FAILED');
            if (!allowMissing && [...packet.expected].some(([token, count]) => counts.get(token) !== count)) throw new PrivacyProtectionError('PRIVACY_RESTORE_FAILED');
            parts.push(result.slice(lastEnd));
            return parts.join('');
        },
        dispose() {values.clear(); originals.clear(); disposed = true;},
    };
}

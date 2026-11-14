import {afterEach, describe, expect, it, vi} from 'vitest';
import {createPrivacyDetector} from '@/src/core/privacy/detect';
import {createPrivacySession} from '@/src/core/privacy/session';
import {MAX_PRIVACY_TEXT_LENGTH, normalizePrivacyPolicy, normalizePrivacyTerms, PRIVACY_CATEGORIES} from '@/src/core/privacy/policy';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, hasCredentialData, isSensitiveConfigKey, mergeConfigCredentials, sanitizeConfigCredentials, sanitizeConfigHistoryCredentials} from '@/src/core/config/credentials';

const policy = normalizePrivacyPolicy({enabled: true, categories: [...PRIVACY_CATEGORIES]});
const detect = createPrivacyDetector(policy);
afterEach(() => vi.unstubAllGlobals());

describe('local privacy detection', () => {
  // 所有数据都是公开格式的人工示例，不来自用户、日志或真实凭据。
  it.each([
    ['email', 'Write to demo+test@example.test today', 'demo+test@example.test'],
    ['email', '联系 示例@例子.测试', '示例@例子.测试'],
    ['phone', '电话：13800138000。', '13800138000'],
    ['phone', 'Call +44 20 7946 0958 now', '+44 20 7946 0958'],
    ['phone', 'Call (202) 555-0123 now', '(202) 555-0123'],
    ['phone', 'tel: 010-55551234', '010-55551234'],
    ['identity', 'ID 11010519491231002X.', '11010519491231002X'],
    ['identity', 'SSN 123-45-6789.', '123-45-6789'],
    ['identity', '护照：E12345678', 'E12345678'],
    ['payment', 'Card 4111 1111 1111 1111.', '4111 1111 1111 1111'],
    ['payment', 'Card 5555 5555 5555 4444.', '5555 5555 5555 4444'],
    ['payment', 'Card 2223 0031 2200 3222.', '2223 0031 2200 3222'],
    ['payment', 'IBAN GB82 WEST 1234 5698 7654 32', 'GB82 WEST 1234 5698 7654 32'],
    ['payment', '银行账号：12345678901', '12345678901'],
    ['secret', 'password: "synthetic value"', 'synthetic value'],
    ['secret', "pwd='synthetic value'", 'synthetic value'],
    ['secret', '验证码：246810', '246810'],
    ['secret', 'api_key=synthetic-example', 'synthetic-example'],
    ['secret', 'Token sk-proj-THIS_IS_A_SYNTHETIC_EXAMPLE', 'sk-proj-THIS_IS_A_SYNTHETIC_EXAMPLE'],
    ['secret', 'Key AKIAEXAMPLEONLY12345', 'AKIAEXAMPLEONLY12345'],
    ['secret', 'Bearer synthetic-bearer-value', 'synthetic-bearer-value'],
    ['secret', 'eyJfakeabc.defghijk.lmnopqrst', 'eyJfakeabc.defghijk.lmnopqrst'],
    ['secret', 'mnemonic: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'],
    ['network', 'Server 192.0.2.1.', '192.0.2.1'],
  ])('identifies %s in %s', (_category, text, value) => {
    expect(detect(text).map(span => text.slice(span.start, span.end))).toContain(value);
  });
  it('does not treat ordinary years, dates, versions or invalid checksums as secrets', () => {
    for (const text of ['2026 2027 246810', '2026-11-14', 'version 1.2.3', '999.999.999.999',
      '4111111111111112', '11010519490231002X', '110105194912310021', '000-00-0000', '0000000000000', 'GB00 WEST 1234 5698 7654 32',
      '2222222222222', '2200000000000000', '2800000000000000']) {
      expect(detect(text), text).toEqual([]);
    }
  });
  it('masks complete and incomplete PEM blocks without rescanning their contents', () => {
    const complete = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----';
    const text = complete + '\n-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC';
    expect(detect(text).map(span => text.slice(span.start, span.end))).toEqual([complete, text.slice(complete.length + 1)]);
  });
  it('detects full-width and zero-width obfuscation while restoring exact original spelling', () => {
    const input = '😀\u3000ｄｅｍｏ＠ｅｘａｍｐｌｅ．ｔｅｓｔ; １３８００１３８０００; other@exa\u200bmple.test; 密码：ｓａ\u200cｆｅ\u200d\uFEFF';
    const spans = detect(input);
    expect(spans).toHaveLength(4);
    expect(input.slice(spans[2].start, spans[2].end)).toBe('other@exa\u200bmple.test');
    const session = createPrivacySession(policy); const packet = session.mask(input);
    expect(packet.text).not.toContain('１３８'); expect(packet.text).not.toContain('other@');
    expect(session.restore(packet.text, packet)).toBe(input); session.dispose();
  });
  it('merges overlapping custom terms and built-in spans without leaving a suffix exposed', () => {
    const text = 'aaabcde zz demo@example.test extra 👩‍💻机密';
    const found = createPrivacyDetector(policy, ['abc', 'bcde', 'aa', 'aab', 'example.test extra', '👩‍💻机密', 'xyz'])(text);
    expect(found.map(span => text.slice(span.start, span.end))).toEqual(['aaabcde', 'demo@example.test extra', '👩‍💻机密']);
  });
  it('respects category choices and exact case, and limits input/match allocation', () => {
    const only = createPrivacyDetector({...policy, categories: []}, ['Project A', 'constructor', '__proto__']);
    expect(only('project a demo@example.test')).toEqual([]);
    expect(only('Project A constructor __proto__')).toHaveLength(3);
    expect(() => only('a'.repeat(MAX_PRIVACY_TEXT_LENGTH + 1))).toThrowError(expect.objectContaining({code: 'PRIVACY_CAPACITY_EXCEEDED'}));
    expect(() => createPrivacyDetector(policy, ['a'])('a'.repeat(10_001))).toThrowError(expect.objectContaining({code: 'PRIVACY_CAPACITY_EXCEEDED'}));
  });
});

describe('request-owned privacy restoration', () => {
  it('round-trips Unicode, repeated values and adjacent spans with stable tokens', () => {
    const session = createPrivacySession(policy, ['秘密', '👩‍💻']);
    const input = '秘密👩‍💻 demo@example.test 与 demo@example.test';
    const packet = session.mask(input);
    expect(packet.text).not.toContain('demo@example.test');
    expect(session.tokens).toHaveLength(3);
    expect(session.restore(packet.text, packet)).toBe(input);
    expect(session.mask('demo@example.test').text).toBe(session.tokens[2]);
    session.dispose();
    expect(session.tokens).toEqual([]);
    expect(() => session.mask(input)).toThrowError(expect.objectContaining({code: 'PRIVACY_SESSION_UNAVAILABLE'}));
    expect(() => session.restore(input, packet)).toThrow();
  });
  it('rejects missing, duplicated, mutated, invented, non-string and cross-slot output', () => {
    const session = createPrivacySession(policy);
    const first = session.mask('First demo@example.test');
    const second = session.mask('Second other@example.test');
    const token = session.tokens[0];
    for (const value of [null, '', first.text + token, first.text.toLowerCase(), first.text.replace(token, token.slice(0, -2)),
      first.text.replace(token, token.replace('_0__', '_ZZ__')), second.text]) {
      expect(() => session.restore(value, first)).toThrowError(expect.objectContaining({code: 'PRIVACY_RESTORE_FAILED'}));
    }
    expect(session.restore('Summary without personal details.', first, true)).toBe('Summary without personal details.');
    expect(() => session.restore(second.text, first, true)).toThrow();
    expect(session.restore(first.text, first, true)).toBe('First demo@example.test');
    session.dispose();
  });
  it('isolates parallel sessions and cannot use context tokens in a clean origin', () => {
    const a = createPrivacySession(policy), b = createPrivacySession(policy);
    const clean = a.mask('Ordinary text');
    const packet = a.mask('demo@example.test');
    expect(() => a.restore(packet.text, clean)).toThrow();
    const other = b.mask('demo@example.test');
    expect(other.text).not.toBe(packet.text);
    expect(() => a.restore(other.text, packet)).toThrow();
    expect(a.restore('译文', clean)).toBe('译文');
    a.dispose(); b.dispose();
  });
  it('blocks before transmission and fails closed without secure randomness', () => {
    expect(() => createPrivacySession({...policy, mode: 'block'}).mask('demo@example.test')).toThrowError(expect.objectContaining({code: 'PRIVACY_CONTENT_BLOCKED'}));
    vi.stubGlobal('crypto', {getRandomValues() {throw new Error('unavailable');}});
    const clean = createPrivacySession(policy); const packet = clean.mask('普通文本');
    expect(clean.restore('译文', packet)).toBe('译文');
    expect(() => clean.mask('demo@example.test')).toThrowError(expect.objectContaining({code: 'PRIVACY_SESSION_UNAVAILABLE'}));
    clean.dispose();
  });
  it('bounds total work across fields and handles a namespace collision safely', () => {
    const session = createPrivacySession(policy);
    for (let index = 0; index < 4; index++) session.mask('a'.repeat(MAX_PRIVACY_TEXT_LENGTH));
    expect(() => session.mask('a')).toThrowError(expect.objectContaining({code: 'PRIVACY_CAPACITY_EXCEEDED'}));
    const collision = createPrivacySession(policy);
    const packet = collision.mask('demo@example.test');
    expect(() => collision.mask(packet.text + ' demo@example.test')).toThrowError(expect.objectContaining({code: 'PRIVACY_SESSION_UNAVAILABLE'}));
    session.dispose(); collision.dispose();
  });
  it('caps both one oversized field and the number of mappings across separate fields', () => {
    const oversized = createPrivacySession(policy);
    expect(() => oversized.mask('a'.repeat(MAX_PRIVACY_TEXT_LENGTH + 1))).toThrowError(expect.objectContaining({code: 'PRIVACY_CAPACITY_EXCEEDED'}));
    oversized.dispose();
    const session = createPrivacySession({...policy, categories: ['email']});
    session.mask(Array.from({length: 10_000}, (_, index) => `fixture${index}@example.test`).join(' '));
    expect(() => session.mask('another@example.test')).toThrowError(expect.objectContaining({code: 'PRIVACY_CAPACITY_EXCEEDED'}));
    session.dispose();
  });
});

describe('privacy settings and credential ownership', () => {
  it('defaults off, bounds custom phrases, and normalizes untrusted imports', () => {
    expect(new Config().privacyProtection.enabled).toBe(false);
    expect(normalizePrivacyPolicy(null)).toEqual(normalizePrivacyPolicy({}));
    expect(normalizePrivacyPolicy({enabled: 'yes', mode: 'other', categories: ['email', 'email', 'unknown']})).toEqual({enabled: false, mode: 'mask', categories: ['email']});
    expect(normalizePrivacyPolicy({enabled: true, mode: 'block', categories: []}).mode).toBe('block');
    expect(normalizePrivacyTerms('secret')).toEqual([]);
    expect(normalizePrivacyTerms(['  示例  ', '示例', '', 1, 'x'.repeat(257)])).toEqual(['示例']);
    expect(normalizePrivacyTerms(Array.from({length: 140}, (_, i) => `phrase-${i}`))).toHaveLength(128);
    expect(normalizeConfig({privacyProtection: policy, privacyProtectionSecretTerms: ['  示例 ']}).privacyProtectionSecretTerms).toEqual(['示例']);
  });
  it('keeps sensitive phrases out of public config, history and ordinary export', () => {
    const config = new Config(); config.privacyProtection = policy; config.privacyProtectionSecretTerms = ['内部示例'];
    const credentials = extractConfigCredentials(config);
    expect(hasCredentialData(credentials)).toBe(true);
    expect(credentials.privacyProtectionSecretTerms).toEqual(['内部示例']);
    // 旧客户端不知道新字段时，既有 Secret 命名规则仍能排除它。
    expect(isSensitiveConfigKey('privacyProtectionSecretTerms')).toBe(true);
    const safe = sanitizeConfigCredentials(config);
    expect(JSON.stringify(safe)).not.toContain('内部示例');
    expect(safe.privacyProtection).toEqual(policy);
    expect(mergeConfigCredentials(safe, credentials).privacyProtectionSecretTerms).toEqual(['内部示例']);
    expect(JSON.stringify(sanitizeConfigHistoryCredentials({entries: [{config}]}))).not.toContain('内部示例');
  });
});

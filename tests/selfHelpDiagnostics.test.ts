import {translate, resolveUiLanguageFromLocale} from '@/src/core/i18n';
import {describe, expect, it} from 'vitest';
import {
  buildDiagnosticReport, diagnoseFailure, DIAGNOSTIC_CODES,
  getDiagnosticText, getDiagnosticUiText, normalizeDiagnostic,
  type DiagnosticCode, type DiagnosticReportInput,
} from '../src/services/diagnostics';
import {serializeTranslationError, TranslationRequestError} from '../src/services/translation/errors';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();

describe('self help diagnosis', () => {
  it('preserves structured error meaning across the existing translation message boundary', () => {
    const error = new TranslationRequestError(serializeTranslationError(Object.assign(
      new Error('timeout: private body at https://private.example?token=secret'),
      {kind: 'authentication', statusCode: 401, retryable: false, requestId: 'private-id'},
    )));
    const diagnostic = diagnoseFailure(error);
    expect(diagnostic.code).toBe('authentication');
    expect(diagnostic.actions).toEqual(['services', 'retry', 'dismiss']);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|secret|https:|timeout/);
  });

  it.each([
    [{kind: 'rate-limit', message: 'invalid model', retryAfterMs: 10_500}, 'rate-limit'],
    [{kind: 'timeout', statusCode: 401}, 'timeout'],
    [{kind: 'network'}, 'network'],
    [{kind: 'provider'}, 'provider'],
    [{kind: 'response'}, 'provider'],
    [{kind: 'bad-request', message: 'invalid parameter'}, 'configuration'],
    [{kind: 'bad-request', code: 'model_not_found'}, 'model-configuration'],
    [{code: 'browser-translation-preparation-required', message: 'network'}, 'browser-translation-preparation-required'],
    [{code: 'browser-translation-unavailable', message: 'model not found'}, 'browser-translation-unavailable'],
    [{kind: 'unknown', statusCode: 403}, 'authentication'],
    [{kind: 'invalid', status: 429}, 'rate-limit'],
    [{statusCode: 408}, 'timeout'],
    [{statusCode: 504}, 'timeout'],
    [{statusCode: 503}, 'provider'],
    [{statusCode: 400}, 'configuration'],
  ] as const)('uses actionable structured metadata for %j', (error, expected) => {
    expect(diagnoseFailure(error).code).toBe(expected);
  });

  it.each([
    ['Extension context invalidated.', 'context-invalid'],
    ['Could not establish connection. Receiving end does not exist.', 'page-unavailable'],
    ['Receiving end does not exist.', 'page-unavailable'],
    ['消息发送失败：无接收端', 'page-unavailable'],
    ['接收端不存在', 'page-unavailable'],
    ['API key is invalid', 'authentication'],
    ['凭据未配置', 'authentication'],
    ['model abc not found', 'model-configuration'],
    [{code: 'invalid_model'}, 'model-configuration'],
    [{code: 'authentication'}, 'authentication'],
    ['请求过于频繁', 'rate-limit'],
    [{code: 'rate_limit'}, 'rate-limit'],
    ['请求超时', 'timeout'],
    [{name: 'TimeoutError'}, 'timeout'],
    ['Failed to fetch', 'network'],
    ['服务暂时不可用', 'provider'],
    ['Unexpected error with private text', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ] as const)('supports older error boundaries without exposing raw messages for %j', (error, expected) => {
    expect(diagnoseFailure(error).code).toBe(expected);
  });

  it('reports offline only when it is relevant and never hides known credentials or quota errors', () => {
    expect(diagnoseFailure(new Error('network error'), {online: false}).code).toBe('offline');
    expect(diagnoseFailure({kind: 'network'}, {online: false}).code).toBe('offline');
    expect(diagnoseFailure({kind: 'authentication'}, {online: false}).code).toBe('authentication');
    expect(diagnoseFailure({statusCode: 429}, {online: false}).code).toBe('rate-limit');
    expect(diagnoseFailure({code: 'invalid_api_key'}, {online: false}).code).toBe('authentication');
    expect(diagnoseFailure({code: 'invalid_model'}, {online: false}).code).toBe('model-configuration');
    expect(diagnoseFailure({kind: 'network', message: 'Could not establish connection'}).code).toBe('network');
  });

  it('offers page repair for a missing content receiver without claiming the extension was updated or exposing transport details', () => {
    const error = new Error('Could not establish connection. Receiving end does not exist. https://private.example/?token=SECRET');
    const diagnostic = diagnoseFailure(error);
    expect(diagnostic.code).toBe('page-unavailable');expect(diagnostic.actions).toEqual(['refresh', 'dismiss']);
    expect(getDiagnosticText(diagnostic).title).toBe('网页翻译组件暂不可用');
    expect(getDiagnosticText(diagnostic).detail).toContain('访问权限');
    expect(getDiagnosticText(diagnostic).detail).not.toContain('已更新');
    expect(normalizeDiagnostic({...diagnostic, actions: ['services'], message: error.message})).toEqual(diagnostic);
    const report = buildDiagnosticReport({diagnostic, feature: 'popup'});
    expect(report).toEqual({schemaVersion: 1, diagnostic: {code: 'page-unavailable'}, feature: 'popup'});
    expect(JSON.stringify([diagnostic, report])).not.toMatch(/private|SECRET|https:|message/);
  });

  it('recognizes only definite missing-tab failures and offers reopening guidance without a dead-tab refresh', () => {
    const expected = diagnoseFailure(undefined, {reason: 'source-closed'});
    for (const error of ['No tab with id: 7.', new Error('No tab with id: 488121272.'), 'Error: No active tab', 'No active tab']) {
      expect(diagnoseFailure(error)).toEqual(expected);
    }
    expect(expected.actions).toEqual(['dismiss']);
    expect(getDiagnosticText(expected).detail).toBe('请重新打开需要翻译的网页，再打开流畅阅读。');
    expect(normalizeDiagnostic({...expected, actions: ['refresh'], message: 'private'})).toEqual(expected);
    expect(buildDiagnosticReport({diagnostic: expected, feature: 'popup'})).toEqual({schemaVersion: 1, diagnostic: {code: 'source-closed'}, feature: 'popup'});
    for (const message of ['temporary tabs lookup failure', 'No tab with id: private text', 'Provider says No active tab', 'No tab with id: 7. https://private.example']) {
      expect(diagnoseFailure(new Error(message)).code).toBe('unknown');
    }
    expect(diagnoseFailure({kind: 'provider', message: 'No active tab'}).code).toBe('provider');
    expect(diagnoseFailure('No active tab', {online: false}).code).toBe('source-closed');
  });

  it('distinguishes a cancelled request from a provider failure', () => {
    for (const error of [{name: 'AbortError'}, {code: 'ERR_CANCELED'}, {code: 'ABORT_ERR'}]) {
      expect(diagnoseFailure(error).code).toBe('cancelled');
    }
    expect(diagnoseFailure({kind: 'authentication'}, {reason: 'cancelled'}).code).toBe('cancelled');
    expect(diagnoseFailure(new Error('failed'), {reason: 'no-content'}).code).toBe('no-content');
    expect(diagnoseFailure(undefined, {reason: 'unsupported-page'}).actions).toEqual(['dismiss']);
    expect(diagnoseFailure(undefined, {reason: 'configuration'}).actions).toEqual(['services', 'retry', 'dismiss']);
    const saveFailure = diagnoseFailure(new Error('save timeout'), {reason: 'configuration-save'});
    expect(saveFailure.code).toBe('configuration-save');
    expect(saveFailure.actions).toEqual(['retry', 'dismiss']);
    expect(getDiagnosticText(saveFailure).detail).toContain('连接检查尚未开始');
  });

  it('only carries finite positive waits for rate limits and explicit 503 delays', () => {
    expect(diagnoseFailure({kind: 'rate-limit', retryAfterMs: 1234.1}).retryAfterMs).toBe(1235);
    expect(diagnoseFailure({message: '429', retryAfterMs: 30_000}).retryAfterMs).toBe(30_000);
    expect(diagnoseFailure({kind: 'rate-limit', retryAfterMs: 172_800_000}).retryAfterMs).toBe(172_800_000);
    for (const retryAfterMs of [NaN, Infinity, -1, 0, '5000']) {
      expect(diagnoseFailure({kind: 'rate-limit', retryAfterMs})).not.toHaveProperty('retryAfterMs');
    }
    expect(diagnoseFailure({kind: 'authentication', retryAfterMs: 5000})).not.toHaveProperty('retryAfterMs');
    const unavailable = diagnoseFailure({kind: 'provider', statusCode: 503, retryAfterMs: 2000});
    expect(unavailable).toMatchObject({code: 'provider', retryAfterMs: 2000});
    expect(normalizeDiagnostic(unavailable)).toEqual(unavailable);
    expect(diagnoseFailure({kind: 'provider', statusCode: 502, retryAfterMs: 2000})).not.toHaveProperty('retryAfterMs');
  });

  it('rebuilds untrusted runtime diagnostics and rejects unsupported codes', () => {
    expect(normalizeDiagnostic({code: 'authentication', titleKey: 'private text', actions: ['export'], message: 'secret'}))
      .toEqual(diagnoseFailure({kind: 'authentication'}));
    expect(normalizeDiagnostic({code: 'rate-limit', retryAfterMs: 4321.1}))
      .toEqual(diagnoseFailure({kind: 'rate-limit', retryAfterMs: 4322}));
    expect(normalizeDiagnostic({code: 'timeout', retryAfterMs: 1234})).not.toHaveProperty('retryAfterMs');
    for (const value of [null, undefined, 'timeout', {}, {code: 'https://private.example'}, {code: ['timeout']}]) {
      expect(normalizeDiagnostic(value)).toBeUndefined();
    }
  });

  it('allows independent consumers to handle and dismiss the same error safely', () => {
    const first = diagnoseFailure({kind: 'timeout'});
    first.actions.pop();
    expect(diagnoseFailure({kind: 'timeout'}).actions).toContain('dismiss');
    expect(diagnoseFailure(new Error('Extension context invalidated')).actions).toEqual(['refresh', 'dismiss']);
  });

  it.each(['authentication', 'model-configuration', 'configuration'] as const)('normalizes %s to service inspection followed by explicit retry only', code => {
    expect(normalizeDiagnostic({code, actions: ['refresh'], message: 'PRIVATE'})).toMatchObject({code, actions: ['services', 'retry', 'dismiss']});
    for (const other of ['source-closed', 'unsupported-page'] as const) expect(normalizeDiagnostic({code: other})!.actions).toEqual(['dismiss']);
  });

  it('provides registered language recovery guidance and labels for every diagnosis', () => {
    for (const code of DIAGNOSTIC_CODES) {
      const diagnostic = {code};
      for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'fr']) {
        const copy = getDiagnosticText(diagnostic, locale);
        expect(copy.title.length).toBeGreaterThan(3);
        expect(copy.detail.length).toBeGreaterThan(15);
        expect(copy.title).not.toContain('diagnostics.');
      }
    }
    for (const action of ['retry', 'services', 'site-settings', 'refresh', 'dismiss'] as const) {
      expect(translate(`diagnostics.action.${action}`, resolveUiLanguageFromLocale('zh-CN'))).not.toBe(translate(`diagnostics.action.${action}`, resolveUiLanguageFromLocale('en')));
    }
    expect(getDiagnosticText({code: 'cancelled'}, 'zh-HK')).toEqual(getDiagnosticText({code: 'cancelled'}));
    expect(translate(`diagnostics.action.${'retry'}`, resolveUiLanguageFromLocale('zh-CN'))).toBe('重试');
    const copy = getDiagnosticText({code: 'unknown'});
    copy.title = 'changed';
    expect(getDiagnosticText({code: 'unknown'}).title).not.toBe('changed');
  });

  it('provides all diagnostic explanations, recovery actions and first-use/report copy in seven languages', () => {
    const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'];
    const uiKeys = ['close-details', 'dismiss-notice', 'details', 'service-action', 'site-action', 'preview', 'report', 'privacy', 'export', 'exportFailed', 'first-use-start', 'first-use-translating', 'first-use-ready',
      'refresh-failed', 'source-closed', 'source-looking', 'source-return', 'source-unavailable', 'source-returned', 'source-return-hint'] as const;
    const actions = ['retry', 'services', 'site-settings', 'refresh', 'dismiss'] as const;
    for (const locale of locales) {
      for (const code of DIAGNOSTIC_CODES) {
        const copy = getDiagnosticText({code}, locale);
        const summary = translate(`diagnostics.${({code}).code}.summary`, resolveUiLanguageFromLocale(locale));
        expect(summary.trim().length).toBeGreaterThan(2);expect(summary.length).toBeLessThanOrEqual(40);
        expect(summary).not.toMatch(/diagnostics\.|https?:|API Key/);
        expect(copy.title.trim().length).toBeGreaterThan(3);expect(copy.detail.trim().length).toBeGreaterThan(15);
        if (locale !== 'en-US') {expect(copy.title).not.toBe(getDiagnosticText({code}, 'en-US').title);expect(copy.detail).not.toBe(getDiagnosticText({code}, 'en-US').detail);}
      }
      for (const action of actions) {
        expect(translate(`diagnostics.action.${action}`, resolveUiLanguageFromLocale(locale)).trim()).not.toBe('');
        if (locale !== 'en-US') expect(translate(`diagnostics.action.${action}`, resolveUiLanguageFromLocale(locale))).not.toBe(translate(`diagnostics.action.${action}`, resolveUiLanguageFromLocale('en-US')));
      }
      for (const key of uiKeys) {
        expect(getDiagnosticUiText(key, locale).trim()).not.toBe('');
        if (locale !== 'en-US') expect(getDiagnosticUiText(key, locale)).not.toBe(getDiagnosticUiText(key, 'en-US'));
      }
    }
    expect(getDiagnosticUiText('preview')).toBe(getDiagnosticUiText('preview', 'zh-CN'));
    expect(translate(`diagnostics.${({code: 'authentication'}).code}.summary`, resolveUiLanguageFromLocale('zh-CN'))).toBe('服务验证失败');
  });

  it('routes supported language variants and uses the shared default for unsupported or empty locales', () => {
    for (const [variant, canonical] of [['zh-TW', 'zh-CN'], ['EN-gb', 'en-US'], ['ja_JP', 'ja-JP'], ['ko', 'ko-KR'], ['fr-CA', 'fr-FR'], ['ru', 'ru-RU'], ['es-MX', 'es-ES']]) {
      expect(getDiagnosticText({code: 'authentication'}, variant)).toEqual(getDiagnosticText({code: 'authentication'}, canonical));
      expect(translate(`diagnostics.${({code: 'authentication'}).code}.summary`, resolveUiLanguageFromLocale(variant))).toBe(translate(`diagnostics.${({code: 'authentication'}).code}.summary`, resolveUiLanguageFromLocale(canonical)));
      expect(translate(`diagnostics.action.${'retry'}`, resolveUiLanguageFromLocale(variant))).toBe(translate(`diagnostics.action.${'retry'}`, resolveUiLanguageFromLocale(canonical)));
      expect(getDiagnosticUiText('first-use-ready', variant)).toBe(getDiagnosticUiText('first-use-ready', canonical));
    }
    for (const locale of ['', 'pt-BR', 'unknown-language']) {
      expect(getDiagnosticText({code: 'page-unavailable'}, locale)).toEqual(getDiagnosticText({code: 'page-unavailable'}, 'zh-CN'));
      expect(translate(`diagnostics.action.${'services'}`, resolveUiLanguageFromLocale(locale))).toBe(translate(`diagnostics.action.${'services'}`, resolveUiLanguageFromLocale('zh-CN')));
      expect(getDiagnosticUiText('privacy', locale)).toBe(getDiagnosticUiText('privacy', 'zh-CN'));
      expect(translate(`diagnostics.${({code: 'page-unavailable'}).code}.summary`, resolveUiLanguageFromLocale(locale))).toBe(translate(`diagnostics.${({code: 'page-unavailable'}).code}.summary`, resolveUiLanguageFromLocale('zh-CN')));
    }
  });
});

describe('local diagnostic report preview', () => {
  it('retains useful reproducible categories and omits the entire private input graph', () => {
    const input = {
      diagnostic: {...diagnoseFailure({kind: 'rate-limit', retryAfterMs: 5000}), message: 'private response'},
      feature: 'popup', serviceType: 'custom', extensionVersion: '0.0.38', online: false,
      url: 'https://private.example/path?apiKey=secret', model: 'private-model', requestId: 'secret-id',
      text: 'private document', headers: {Authorization: 'Bearer private-key'}, config: {apiKey: 'private-key'},
      error: new Error('private body'),
    };
    const report = buildDiagnosticReport(input as DiagnosticReportInput);
    expect(report).toEqual({schemaVersion: 1, diagnostic: {code: 'rate-limit', retryAfterMs: 5000},
      feature: 'popup', serviceType: 'custom', extensionVersion: '0.0.38', online: false});
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(JSON.stringify(report)).not.toMatch(/private|secret|Bearer|apiKey|requestId|headers|url|model|message/);
    expect(input.diagnostic.message).toBe('private response');
  });

  it('rejects arbitrary data hidden in allowed field names and does not invoke serialization hooks', () => {
    const secret = {toJSON() { throw new Error('must not serialize input'); }};
    const report = buildDiagnosticReport({
      diagnostic: {code: 'private body', retryAfterMs: secret}, feature: 'https://private.example',
      serviceType: {type: 'ai', key: 'secret'}, extensionVersion: '0.0.38-secret', online: secret,
      nested: secret,
    } as unknown as DiagnosticReportInput);
    expect(report).toEqual({schemaVersion: 1, diagnostic: {code: 'unknown'}});
    expect(JSON.stringify(report)).toBe('{"schemaVersion":1,"diagnostic":{"code":"unknown"}}');
  });

  it('does not preserve retry metadata outside rate limits or invalid version syntax', () => {
    expect(buildDiagnosticReport({diagnostic: {code: 'network', retryAfterMs: 100}})).toEqual({
      schemaVersion: 1, diagnostic: {code: 'network'},
    });
    for (const version of ['', '0', '1.2.3.4.5', '1.2\n', 'https://secret.example', '1.2.3-secret']) {
      expect(buildDiagnosticReport({diagnostic: {code: 'unknown'}, extensionVersion: version})).not.toHaveProperty('extensionVersion');
    }
    expect(buildDiagnosticReport({diagnostic: {code: 'rate-limit', retryAfterMs: Infinity}})).toEqual({
      schemaVersion: 1, diagnostic: {code: 'rate-limit'},
    });
    expect(buildDiagnosticReport(null as unknown as DiagnosticReportInput)).toEqual({schemaVersion: 1, diagnostic: {code: 'unknown'}});
  });

  it('accepts every supported feature/service category and validates codes at runtime', () => {
    for (const feature of ['popup', 'page', 'services', 'selection', 'hover', 'document', 'image', 'video', 'unknown'] as const) {
      expect(buildDiagnosticReport({diagnostic: {code: 'unknown'}, feature}).feature).toBe(feature);
    }
    for (const serviceType of ['free', 'traditional', 'ai', 'custom', 'composite', 'local', 'unknown'] as const) {
      expect(buildDiagnosticReport({diagnostic: {code: 'unknown'}, serviceType}).serviceType).toBe(serviceType);
    }
    for (const code of DIAGNOSTIC_CODES) {
      expect(buildDiagnosticReport({diagnostic: {code}}).diagnostic.code).toBe(code as DiagnosticCode);
    }
  });
});

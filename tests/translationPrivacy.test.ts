import {describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {normalizePrivacyPolicy} from '@/src/core/privacy/policy';
import {preparePrivacyRequest} from '@/src/services/translation/privacyProtection';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {attachTranslationImageInput, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import {serializeTranslationSlots, parseTranslationSlots} from '@/src/core/translation/slotProtocol';
import type {TranslationProviderRequest} from '@/src/services/translation/types';

function current() {
  const config = new Config(); config.service = 'google'; config.from = 'en'; config.to = 'zh-Hans';
  config.privacyProtection = normalizePrivacyPolicy({enabled: true});
  return config;
}
const translated = (text: string) => text.replaceAll('Contact', '请联系').replaceAll('Hello', '你好').replaceAll('Name', '姓名');
function setup(config = current(), implementation?: (request: TranslationProviderRequest) => unknown) {
  const provider = vi.fn(async (request: TranslationProviderRequest) => implementation ? implementation(request)
    : Array.isArray(request.origin) ? request.origin.map(translated) : translated(request.origin));
  const cache = {get: vi.fn(async () => null), set: vi.fn(async () => true), clear: vi.fn(async () => {}), cleanup: vi.fn(async () => {})};
  const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => config,
    providers: {google: provider, openai: provider}, cache,
    serviceTypes: {machine: new Set(['google']), isAI: service => service === 'openai', isAiSdk: () => false, isUseAIContext: service => service === 'openai'},
    endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://translation.invalid/v1'}), aiSdkTransportProfile: 'test'},
    promptBuilder: {buildPageSummaryPrompt: text => `Summarize ${text}`, buildPageSummarySystemPrompt: () => 'Summarize'},
    getMissingCredentialMessage: () => null,
    getTranslationLanguages: override => ({sourceLanguage: override?.sourceLanguage ?? config.from, targetLanguage: override?.targetLanguage ?? config.to}),
    resolveConfiguredModel: (selected, custom) => custom || selected || '', buildTranslationCacheKey: identity => JSON.stringify(identity),
  });
  return {broker, provider, cache, config};
}

describe('privacy provider adapter', () => {
  it('has an identity path when disabled and refuses original images when enabled', () => {
    const config = new Config(), message = {origin: 'Contact demo@example.test'};
    const off = preparePrivacyRequest(message, createTranslationProviderConfigSnapshot(config));
    expect(off.message).toBe(message); expect(off.restore('output')).toBe('output'); off.dispose();
    config.privacyProtection.enabled = true;
    expect(() => preparePrivacyRequest(attachTranslationImageInput({...message}, 'data:image/png;base64,AAAA'), createTranslationProviderConfigSnapshot(config)))
      .toThrowError(expect.objectContaining({code: 'PRIVACY_IMAGE_BLOCKED'}));
  });
  it('protects all text fields, custom prompts and bodies while preserving transport credentials', () => {
    const config = current();
    config.privacyProtectionSecretTerms = ['Private Example'];
    config.system_role.google = 'Contact system@example.test'; config.user_role.google = 'Contact user@example.test {{text}}';
    config.customBody.google = '{"note":"Private Example"}'; config.token.google = 'transport-credential';
    const message = {origin: 'Contact demo@example.test', context: 'Private Example', pageContext: 'page@example.test',
      discourseContext: 'discourse@example.test', subtitleContext: 'subtitle@example.test', sourceLanguageDetectionText: 'sample@example.test'};
    const packet = preparePrivacyRequest(message, createTranslationProviderConfigSnapshot(config));
    const wire = JSON.stringify({...packet.message, system: packet.config.system_role, user: packet.config.user_role, body: packet.config.customBody});
    expect(wire).not.toContain('@'); expect(wire).not.toContain('Private Example');
    expect(packet.config.privacyProtectionSecretTerms).toEqual([]); expect(packet.config.token.google).toBe('transport-credential');
    expect(packet.restore(translated(packet.message.origin as string))).toBe('请联系 demo@example.test');
    expect(message.origin).toBe('Contact demo@example.test'); expect(config.system_role.google).toContain('@');
    packet.dispose(); expect(() => packet.restore('late result')).toThrow();
  });
  it('checks array and structured text slots independently, rejecting cross-slot substitution', () => {
    const config = createTranslationProviderConfigSnapshot(current());
    const texts = ['Contact one@example.test', 'Contact two@example.test'];
    const array = preparePrivacyRequest({origin: texts}, config);
    const masked = array.message.origin as string[];
    expect(array.restore(masked.map(translated))).toEqual(texts.map(translated));
    expect(() => array.restore([...masked].reverse())).toThrow();
    expect(() => array.restore([masked[0]])).toThrow(); array.dispose();
    const slots = serializeTranslationSlots(texts, 'privacy-test');
    const structured = preparePrivacyRequest({origin: slots.payload}, config);
    const outputs = parseTranslationSlots(slots, structured.message.origin as string)!;
    expect(structured.restore(serializeTranslationSlots(outputs.map(translated), 'privacy-test').payload)).toBe(serializeTranslationSlots(texts.map(translated), 'privacy-test').payload);
    expect(() => structured.restore(serializeTranslationSlots([...outputs].reverse(), 'privacy-test').payload)).toThrow();
    expect(() => structured.restore('broken slots')).toThrow(); expect(() => structured.restore(null)).toThrow(); structured.dispose();
  });
  it('decodes custom JSON bodies before scanning and masks entire labelled secrets', () => {
    const config = current();
    config.customBody.google = '{"note":"demo\\u0040example.test","password":"fake \\"quoted\\" value","otp":246810,"temperature":0}';
    const packet = preparePrivacyRequest({origin: 'Hello'}, createTranslationProviderConfigSnapshot(config));
    const body = JSON.parse(packet.config.customBody.google);
    expect(body.note).not.toContain('@'); expect(body.password).not.toContain('fake'); expect(body.password).not.toContain('value');
    expect(body.otp).toMatch(/^__FRP_/u); expect(body.temperature).toBe(0); packet.dispose();
  });
  it('handles empty templates and malformed custom JSON without bypassing detection', () => {
    const config = current(); config.system_role.google = ''; config.user_role.google = '';
    config.customBody.google = 'not-json demo@example.test'; config.customBody.empty = '';
    const snapshot = {...createTranslationProviderConfigSnapshot(config), glossaryProtectedTokens: ['__FRTERM_SAMPLE__']};
    const packet = preparePrivacyRequest({origin: 'Hello'}, snapshot);
    expect(packet.config.customBody.google).not.toContain('@'); expect(packet.config.customBody).not.toHaveProperty('empty');
    expect(packet.config.system_role.google).toBe(''); expect(packet.config.glossaryProtectedTokens).toContain('__FRTERM_SAMPLE__');
    packet.dispose();
  });
  it('allows summaries to omit sensitive values but never to borrow context values', () => {
    const packet = preparePrivacyRequest({origin: 'Contact demo@example.test', summaryPrompt: 'Summarize demo@example.test', summarySystemPrompt: 'summary@example.test'} as TranslationProviderRequest<string>,
      createTranslationProviderConfigSnapshot(current()));
    expect(packet.restore('普通摘要')).toBe('普通摘要');
    expect(JSON.stringify(packet.message)).not.toContain('@');
    packet.dispose();
  });
  it('freezes policy and sensitive phrases before asynchronous work', () => {
    const config = current(); config.privacyProtectionSecretTerms = ['Private Example'];
    const snapshot = createTranslationProviderConfigSnapshot(config);
    config.privacyProtection.enabled = false; config.privacyProtection.categories.length = 0; config.privacyProtectionSecretTerms.length = 0;
    expect(snapshot.privacyProtection?.enabled).toBe(true); expect(snapshot.privacyProtection?.categories).toContain('email');
    expect(snapshot.privacyProtectionSecretTerms).toEqual(['Private Example']);
  });
});

describe('translation broker privacy enforcement', () => {
  it('never transmits raw detected text, restores locally and skips persistent cache', async () => {
    const {broker, provider, cache} = setup();
    const request = {origin: 'Contact demo@example.test'};
    expect(await broker.translateWithCache(request)).toBe('请联系 demo@example.test');
    expect(await broker.translateWithCache(request)).toBe('请联系 demo@example.test');
    expect(provider).toHaveBeenCalledTimes(2);
    for (const [call] of provider.mock.calls) expect(JSON.stringify(call)).not.toContain('demo@example.test');
    expect(cache.get).not.toHaveBeenCalled(); expect(cache.set).not.toHaveBeenCalled();
  });
  it('blocks sensitive requests and image requests before provider invocation', async () => {
    const {broker, provider, config} = setup(); config.privacyProtection.mode = 'block';
    await expect(broker.translateWithCache({origin: 'Contact demo@example.test'})).rejects.toMatchObject({code: 'PRIVACY_CONTENT_BLOCKED', retryable: false});
    await expect(broker.translateWithCache(attachTranslationImageInput({origin: 'Hello'}, 'data:image/png;base64,AAAA'))).rejects.toMatchObject({code: 'PRIVACY_IMAGE_BLOCKED'});
    expect(provider).not.toHaveBeenCalled();
  });
  it('preflights block mode before any summary and ignores unused service templates', async () => {
    const config = current(); config.service = 'openai'; config.enableAIContext = true; config.privacyProtection.mode = 'block';
    config.system_role.google = 'Unused demo@example.test';
    const {broker, provider} = setup(config);
    await expect(broker.translateWithCache({origin: 'Contact demo@example.test', pageContext: 'Ordinary background. '.repeat(50)})).rejects.toMatchObject({code: 'PRIVACY_CONTENT_BLOCKED'});
    expect(provider).not.toHaveBeenCalled();
    expect(await broker.translateWithCache({origin: 'Hello'})).toBe('你好');
  });
  it('does not retry a damaged privacy marker or cache the result', async () => {
    const {broker, provider, cache} = setup(current(), () => '请联系');
    await expect(broker.translateWithCache({origin: 'Contact demo@example.test'})).rejects.toMatchObject({code: 'PRIVACY_RESTORE_FAILED', retryable: false});
    expect(provider).toHaveBeenCalledTimes(1); expect(cache.set).not.toHaveBeenCalled();
  });
  it('covers native batches, preserves duplicate positions and rejects mixed-up rows', async () => {
    const {broker, provider} = setup();
    const input = ['Contact one@example.test', 'Contact two@example.test', 'Contact one@example.test'];
    expect(await broker.translateWithCache({origin: input})).toEqual(input.map(translated));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider.mock.calls[0][0])).not.toContain('@');
    const swapped = setup(current(), message => (message.origin as string[]).map(translated).reverse());
    await expect(swapped.broker.translateWithCache({origin: input.slice(0, 2)})).rejects.toMatchObject({code: 'PRIVACY_RESTORE_FAILED'});
  });
  it('also sanitizes the separate page-summary request and a fallback retry', async () => {
    const config = current(); config.service = 'openai'; config.enableAIContext = true;
    const calls: TranslationProviderRequest[] = [];
    const {broker, cache} = setup(config, request => {
      calls.push(request);
      return request.summaryPrompt ? '普通背景摘要' : translated(request.origin as string);
    });
    expect(await broker.translateWithCache({origin: 'Contact demo@example.test', pageContext: 'page@example.test. ' + 'Background material. '.repeat(30)})).toBe('请联系 demo@example.test');
    expect(calls.some(call => call.summaryPrompt)).toBe(true);
    for (const call of calls) expect(JSON.stringify(call)).not.toContain('@');
    expect(cache.get).not.toHaveBeenCalled(); expect(cache.set).not.toHaveBeenCalled();
  });
  it('isolates pending requests when the protection policy changes', async () => {
    const config = current(); config.useCache = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {release = resolve;});
    const {broker, provider} = setup(config, async request => {await barrier; return translated(request.origin as string);});
    const first = broker.translateWithCache({origin: 'Contact demo@example.test'});
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    config.privacyProtection = {...config.privacyProtection, enabled: false};
    const second = broker.translateWithCache({origin: 'Contact demo@example.test'});
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    release(); expect(await first).toBe('请联系 demo@example.test'); expect(await second).toBe('请联系 demo@example.test');
    expect(provider.mock.calls[0][0].origin).not.toContain('@'); expect(provider.mock.calls[1][0].origin).toContain('@');
  });
});

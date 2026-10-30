import {beforeEach, describe, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({
  config: {on: true, videoTranslationEnabled: true, videoSemanticSegmentationEnabled: true,
    videoSemanticSegmentationService: 'test', videoSemanticSegmentationModel: 'model', customOpenAIProviders: [], disabledExtensionDomains: [],
    apiKeys: {test: ['first', 'second']}, token: {test: 'first'}, apiKeyRotationEnabled: {test: true}},
  generate: vi.fn(), model: vi.fn(), subscribe: vi.fn(), removed: vi.fn(), updated: vi.fn(),
}));
vi.mock('ai', () => ({generateText: mocks.generate}));
vi.mock('@/src/services/config/store', () => ({config: mocks.config, subscribeConfig: mocks.subscribe}));
vi.mock('@/src/core/config/harness', () => ({isHarnessService: () => true}));
vi.mock('@/src/services/harness/modelGateway', () => ({createHarnessLanguageModel: mocks.model}));
vi.mock('@/src/services/harness/modelConfig', () => ({snapshotHarnessConfig: (config: unknown) => Object.freeze(structuredClone(config)), getHarnessModelInputKey: () => 'key'}));
vi.mock('@/src/core/site-rules/domain', () => ({isExtensionDisabledOnSite: () => false}));
import {createVideoSemanticRuntime} from '@/src/features/video-subtitle/background/semanticRuntime';
const context = {sender: {id: 'ext', tab: {id: 1, incognito: false}, frameId: 0, documentId: 'document'}};
const input = {type: 'fluentReadSegmentVideoSemantics', algorithmVersion: 2, requestId: 'runtime', cues: [{text: 'A sentence.', startMs: 0, durationMs: 1000}]};
beforeEach(() => {
  vi.clearAllMocks(); mocks.config.videoSemanticSegmentationEnabled = true;
  vi.stubGlobal('browser', {runtime: {id: 'ext'}, extension: {inIncognitoContext: false}, tabs: {onRemoved: {addListener: mocks.removed}, onUpdated: {addListener: mocks.updated}}});
  mocks.generate.mockResolvedValue({finishReason: 'stop', text: '{"boundaries":["b11"]}'});
});
describe('semantic runtime uses explicit one-shot provider transport', () => {
  it('does not mutate frozen snapshot and uses one key with SDK retries disabled', async () => {
    const handlers = createVideoSemanticRuntime();
    expect(await handlers[0].handle(input, context)).toMatchObject({success: true});
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({maxRetries: 0, maxOutputTokens: 8192});
    expect(mocks.model.mock.calls[0][0]).toMatchObject({apiKeys: {test: ['first']}, token: {test: 'first'}, apiKeyRotationEnabled: {test: false}});
    expect(mocks.config.apiKeys.test).toEqual(['first', 'second']);
  });
  it.each(['429', '500', 'network'])('never adds a fallback invocation after %s failure', async error => {
    mocks.generate.mockRejectedValueOnce(new Error(error));
    expect(await createVideoSemanticRuntime()[0].handle(input, context)).toMatchObject({success: false});
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it.each([{finishReason: 'length', text: '{"boundaries":["b11"]}'}, {finishReason: 'stop', text: 'x'.repeat(65537)}, {finishReason: 'stop', text: 'invalid'}])('rejects incomplete or invalid output', async response => {
    mocks.generate.mockResolvedValueOnce(response);
    expect(await createVideoSemanticRuntime()[0].handle(input, context)).toMatchObject({success: false});
  });
  it.each(['config', 'removed', 'navigation'])('actively aborts a pending request on %s', async kind => {
    mocks.generate.mockImplementation(() => new Promise(() => {})); const handlers = createVideoSemanticRuntime();
    const pending = handlers[0].handle(input, context);
    if (kind === 'config') {mocks.config.videoSemanticSegmentationEnabled = false; mocks.subscribe.mock.calls[0][0]();}
    if (kind === 'removed') mocks.removed.mock.calls[0][0](1);
    if (kind === 'navigation') {mocks.updated.mock.calls[0][0](1, {}); mocks.updated.mock.calls[0][0](1, {status: 'loading'});}
    expect(mocks.generate.mock.calls[0][0].abortSignal.aborted).toBe(true);
    expect(await pending).toMatchObject({success: false});
  });
});

it('supports an explicitly configured local service without fabricating credentials', async () => {
  const original = mocks.config.apiKeys.test; mocks.config.apiKeys.test = [];
  try {expect(await createVideoSemanticRuntime()[0].handle(input, context)).toMatchObject({success: true});
    expect(mocks.model.mock.calls[0][0].token.test).toBe('');
  } finally {mocks.config.apiKeys.test = original;}
});

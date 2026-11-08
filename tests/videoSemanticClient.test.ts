import {afterEach, describe, expect, it, vi} from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: send}));
import {requestVideoSemanticBoundaries} from '@/src/features/video-subtitle/content/semanticClient';
import {createSemanticDocument} from '@/src/features/video-subtitle/semanticSegmentation';
const document = createSemanticDocument([{text: 'Sentence.', startMs: 0, durationMs: 1000}]);
afterEach(() => vi.clearAllMocks());
describe('semantic transport identity', () => {
  it('does not send an already aborted request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(requestVideoSemanticBoundaries(document, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects success from another request identity', async () => {
    send.mockResolvedValueOnce({success: true, requestId: 'other', result: {boundaries: ['b9']}});
    await expect(requestVideoSemanticBoundaries(document, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects failed response without echoing remote private error content', async () => {
    send.mockResolvedValueOnce({success: false, error: 'secret'});
    await expect(requestVideoSemanticBoundaries(document, new AbortController().signal)).rejects.toThrow('AI segmentation failed');
  });
});

it('rejects a response produced by another algorithm version', async () => {
  send.mockImplementationOnce(async message => ({success: true, requestId: message.requestId, algorithmVersion: 0, result: {boundaries: ['b9']}}));
  await expect(requestVideoSemanticBoundaries(document, new AbortController().signal)).rejects.toThrow();
});

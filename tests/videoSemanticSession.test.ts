import {describe, expect, it, vi} from 'vitest';
import {VideoSemanticSession} from '@/src/features/video-subtitle/content/semanticSession';
const cues = [{text: 'one two', startMs: 0, durationMs: 1000}];
const answer = {boundaries: ['b4', 'b7']};
const deferred = () => {let resolve!: (value: unknown) => void; const promise = new Promise(resolve_ => {resolve = resolve_;}); return {promise, resolve};};
describe('semantic session ownership', () => {
  it('accepts validated output and captures source before await', async () => {
    const wait = deferred(); const session = new VideoSemanticSession(() => wait.promise, () => 'v1');
    const source = cues.map(cue => ({...cue})); const result = session.request(source);
    source[0].text = 'red fox'; wait.resolve(answer);
    expect((await result).map(unit => unit.text).join('')).toBe('one two');
  });
  it('rejects cancelled late response even if transport ignores abort', async () => {
    const wait = deferred(); const session = new VideoSemanticSession(() => wait.promise, () => 'v1');
    const result = session.request(cues); session.cancel(); wait.resolve(answer);
    await expect(result).rejects.toMatchObject({name: 'AbortError'});
  });
  it('rejects old source response when equal offsets recur in a new document', async () => {
    const first = deferred(); const second = deferred();
    const transport = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new VideoSemanticSession(transport, () => 'v1');
    const old = session.request(cues); const failure = expect(old).rejects.toMatchObject({name: 'AbortError'});
    const fresh = session.request([{...cues[0], text: 'red fox'}]);
    first.resolve(answer); second.resolve(answer);
    await failure; expect((await fresh).map(unit => unit.text).join('')).toBe('red fox');
  });
  it('rejects changed config/video revision without requiring a cooperative transport', async () => {
    let revision = 'old'; const wait = deferred(); const session = new VideoSemanticSession(() => wait.promise, () => revision);
    const result = session.request(cues); revision = 'new'; wait.resolve(answer);
    await expect(result).rejects.toMatchObject({name: 'AbortError'});
  });
  it('bounds stalled requests and releases cancellation listeners', async () => {
    vi.useFakeTimers();
    try {
      const session = new VideoSemanticSession(() => new Promise(() => {}), () => 'v1', 10);
      const result = session.request(cues); const failure = expect(result).rejects.toMatchObject({name: 'TimeoutError'});
      await vi.advanceTimersByTimeAsync(10); await failure; expect(vi.getTimerCount()).toBe(0); session.cancel();
    } finally {vi.useRealTimers();}
  });
  it('rejects malformed response, transport errors and invalid deadlines without caching', async () => {
    await expect(new VideoSemanticSession(async () => ({text: 'rewrite'}), () => 'v1').request(cues)).rejects.toThrow();
    await expect(new VideoSemanticSession(async () => {throw new Error('offline');}, () => 'v1').request(cues)).rejects.toThrow('offline');
    expect(() => new VideoSemanticSession(async () => answer, () => 'v1', 0)).toThrow();
    const transport = vi.fn(); expect(await new VideoSemanticSession(transport, () => 'v1').request([])).toEqual([]); expect(transport).not.toHaveBeenCalled();
  });
});

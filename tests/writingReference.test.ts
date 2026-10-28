import {describe, expect, it, vi} from 'vitest';
import {createWritingReference, type WritingReferenceSnapshot, type WritingReferenceState} from '@/src/features/writing-assistant/reference';
import type {WritingProgress, WritingResponse} from '@/src/features/writing-assistant/types';
const base: WritingReferenceSnapshot = {session: 1, source: 'An English reply.', sourceLanguage: 'en', language: 'zh-Hans', owner: 1, active: true};
function setup() {
  const calls: Array<{source: string; language: string; handlers: {progress(value: WritingProgress): void; result(value: WritingResponse): void}; cancel: ReturnType<typeof vi.fn>}> = [];
  let state: WritingReferenceState = {status: 'idle', text: ''};
  const stream = vi.fn((source, language, handlers) => { const cancel = vi.fn(); calls.push({source, language, handlers, cancel}); return cancel; });
  const controller = createWritingReference({stream, changed: value => { state = value; }});
  const finish = (index: number, text = '中文对照。') => calls[index].handlers.result({success: true, text, service: 'openai', model: 'actual'});
  return {controller, calls, stream, finish, state: () => state};
}
describe('Writing reading translation ownership', () => {
  it('私有模型配置变化导致取消后只自动重试一次，重复变化保留手动恢复', async () => {
    const m=setup();m.controller.update(base);
    const changed={success:false,error:'已停止生成',cancelled:true,reason:'configuration-changed'} as WritingResponse;
    m.calls[0].handlers.result(changed);await new Promise(resolve=>setTimeout(resolve,0));expect(m.calls).toHaveLength(2);
    m.calls[1].handlers.result(changed);await new Promise(resolve=>setTimeout(resolve,0));expect(m.calls).toHaveLength(2);expect(m.state().status).toBe('error');
    m.controller.retry();expect(m.calls).toHaveLength(3);m.finish(2,'新对照');expect(m.state().text).toBe('新对照');
  });
  it('自动恢复前若页面切换或被关闭，迟到回执不再发送请求', async () => {
    const changed={success:false,error:'已停止生成',cancelled:true,reason:'configuration-changed'} as WritingResponse;
    for (const change of [{active:false},{session:2},{source:'new reply'},{language:'es'}]) {
      const m=setup();m.controller.update(base);m.calls[0].handlers.result(changed);
      m.controller.update({...base,...change});const count=m.calls.length;await new Promise(resolve=>setTimeout(resolve,0));expect(m.calls).toHaveLength(count);
      m.controller.dispose();
    }
    const m=setup();m.controller.update(base);m.calls[0].handlers.result(changed);m.controller.dispose();await new Promise(resolve=>setTimeout(resolve,0));expect(m.calls).toHaveLength(1);
  });
  it('手动重试取代排队中的自动恢复，普通断连不会自动重试', async () => {
    const m=setup();m.controller.update(base);
    m.calls[0].handlers.result({success:false,error:'已停止生成',cancelled:true,reason:'configuration-changed'});
    m.controller.retry();await new Promise(resolve=>setTimeout(resolve,0));expect(m.calls).toHaveLength(2);
    m.calls[1].handlers.result({success:false,error:'连接中断'});await new Promise(resolve=>setTimeout(resolve,0));
    expect(m.calls).toHaveLength(2);expect(m.state().status).toBe('error');
  });
  it('调用方不能确认当前页面归属时不自动恢复', async () => {
    let handlers!: {progress(value:WritingProgress):void;result(value:WritingResponse):void};
    const stream=vi.fn((_source,_language,next)=>{handlers=next;return ()=>{};});
    const controller=createWritingReference({stream,changed:()=>{},canRecover:()=>false});controller.update(base);
    handlers.result({success:false,error:'已停止生成',cancelled:true,reason:'configuration-changed'});
    await new Promise(resolve=>setTimeout(resolve,0));expect(stream).toHaveBeenCalledOnce();controller.dispose();
  });
  it('streams a frozen reply into a separate state, deduplicates and caches complete translations', () => {
    const m = setup(); const snapshot = {...base}; m.controller.update(snapshot); snapshot.source = 'changed externally';
    expect(m.calls[0]).toMatchObject({source: base.source, language: 'zh-Hans'}); expect(m.state()).toEqual({status: 'loading', text: ''});
    m.calls[0].handlers.progress({kind: 'model', service: 'openai', model: 'actual'}); expect(m.state().text).toBe('');
    m.calls[0].handlers.progress({kind: 'text', text: '中文'}); expect(m.state()).toEqual({status: 'loading', text: '中文'});
    m.controller.update(base); expect(m.calls).toHaveLength(1);
    m.finish(0); expect(m.state()).toEqual({status: 'success', text: '中文对照。'});
    m.calls[0].handlers.progress({kind: 'text', text: 'late'}); m.finish(0, 'late'); expect(m.state().text).toBe('中文对照。');
    m.controller.update({...base, active: false}); expect(m.state().status).toBe('idle');
    m.controller.update(base); expect(m.calls).toHaveLength(1); expect(m.state().text).toBe('中文对照。');
  });
  it.each([
    {active: false}, {source: ''}, {source: '   '}, {language: ''},
  ])('does not request a translation for inactive, empty or disabled state %j', change => {
    const m = setup(); m.controller.update({...base, ...change}); expect(m.state()).toEqual({status: 'idle', text: ''}); expect(m.calls).toHaveLength(0);
  });
  it('skips same-language replies and refuses to silently truncate long source text', () => {
    const m = setup(); m.controller.update({...base, language: 'en'}); expect(m.state().status).toBe('same-language');
    m.controller.update({...base, source: 'a'.repeat(12001)}); expect(m.state().status).toBe('too-long'); expect(m.calls).toHaveLength(0);
    m.controller.update({...base, source: 'a'.repeat(12000)}); expect(m.calls[0].source).toHaveLength(12000);
  });
  it.each([{source: 'Edited reply.'}, {language: 'es'}, {session: 2}, {owner: 2}, {active: false}])('cancels and rejects late results when the request owner changes: %j', change => {
    const m = setup(); m.controller.update(base); m.calls[0].handlers.progress({kind: 'text', text: 'partial'});
    m.controller.update({...base, ...change}); expect(m.calls[0].cancel).toHaveBeenCalledOnce();
    m.finish(0, 'stale'); m.calls[0].handlers.progress({kind: 'text', text: 'late'}); expect(m.state().text).toBe('');
    if (change.active !== false) { m.finish(1, 'current'); expect(m.state().text).toBe('current'); }
  });
  it('retries failures independently without exposing incomplete text or changing the reply', () => {
    const m = setup(); m.controller.retry(); expect(m.calls).toHaveLength(0);
    m.controller.update(base); m.calls[0].handlers.progress({kind: 'text', text: 'incomplete'});
    m.calls[0].handlers.result({success: false, error: 'provider detail'}); expect(m.state()).toEqual({status: 'error', text: ''});
    m.controller.retry(); expect(m.calls[1].source).toBe(base.source); m.finish(1, ' '); expect(m.state().status).toBe('error');
    m.controller.retry(); m.finish(2); expect(m.state().status).toBe('success'); expect(base.source).toBe('An English reply.');
  });
  it('cleans up synchronous completion, failed connection and unmount', () => {
    const m = setup(); const release = vi.fn();
    m.stream.mockImplementationOnce((_source, _language, handlers) => { handlers.result({success: true, text: 'synchronous', service: 'openai', model: 'actual'}); return release; });
    m.controller.update(base); expect(release).toHaveBeenCalledOnce(); expect(m.state().text).toBe('synchronous');
    m.stream.mockImplementationOnce(() => { throw new Error('connection unavailable'); });
    m.controller.update({...base, source: 'new'}); expect(m.state().status).toBe('error');
    m.controller.retry(); m.controller.dispose(); expect(m.calls[0].cancel).toHaveBeenCalledOnce();
    m.finish(0); m.controller.update(base); expect(m.state().text).toBe(''); expect(m.calls).toHaveLength(1);
  });
  it('releases a request invalidated synchronously during setup and suppresses errors from obsolete setup', () => {
    const m = setup(); const release = vi.fn();
    m.stream.mockImplementationOnce(() => { m.controller.update({...base, active: false}); return release; });
    m.controller.update(base); expect(release).toHaveBeenCalledOnce(); expect(m.state().status).toBe('idle');
    m.stream.mockImplementationOnce(() => { m.controller.update({...base, active: false}); throw new Error('obsolete'); });
    m.controller.update(base); expect(m.state().status).toBe('idle');
  });
  it('bounds version caches and clears them for a new editor or model owner', () => {
    const m = setup();
    for (let index = 0; index < 6; index++) { m.controller.update({...base, source: String(index)}); m.finish(index, `translation-${index}`); }
    m.controller.update({...base, source: '1'}); expect(m.calls).toHaveLength(6); expect(m.state().text).toBe('translation-1');
    m.controller.update({...base, source: '0'}); expect(m.calls).toHaveLength(7); m.finish(6);
    m.controller.update({...base, source: '0', session: 2}); expect(m.calls).toHaveLength(8); m.finish(7);
    m.controller.update({...base, source: '0', session: 2, owner: 2}); expect(m.calls).toHaveLength(9);
  });
});

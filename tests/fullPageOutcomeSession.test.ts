import {describe, expect, it, vi} from 'vitest';
import {createFullPageOutcomeRegistry} from '@/src/features/full-page-translation/core/outcomes';
const ports = vi.hoisted(() => ({
  listener: null as ((node: HTMLElement, state: {phase: 'loading' | 'translated' | 'error'; translationInvocationIdentity?: string} | undefined) => void) | null,
  action: null as ((action: 'retry' | 'locate') => number) | null,
  states: new WeakMap<HTMLElement, {phase: 'loading' | 'translated' | 'error'; translationInvocationIdentity?: string}>(),
  within: vi.fn(() => true), stop: vi.fn(),
}));
vi.mock('@/src/features/full-page-translation/content/state', () => ({
  getTranslationState: (node: HTMLElement) => ports.states.get(node),
  subscribeTranslationStateChanges: (listener: typeof ports.listener) => {ports.listener = listener; return ports.stop;},
}));
vi.mock('@/src/features/full-page-translation/progress', () => ({
  setFullPageFailureActions: (_id: number, action: typeof ports.action) => {ports.action = action;},
}));
vi.mock('@/src/features/full-page-translation/content/modalPriority', () => ({isWithinTranslationModal: ports.within}));
import {bindFullPageOutcomeRecovery, registerFullPageOutcomeTarget, getFullPageOutcomeSummary, getFullPageModalOutcomePhases} from '@/src/features/full-page-translation/content/outcomeSession';

describe('全文会话恢复端口', () => {
  it('阶段通知和命令均核对会话、目标、连接与弹窗身份，释放后无需持有 DOM', () => {
    const target = {isConnected: true, scrollIntoView: vi.fn()} as unknown as HTMLElement;
    const unowned = {isConnected: true} as HTMLElement;
    const outcomes = createFullPageOutcomeRegistry<HTMLElement>();
    const session = {active: true, progressSessionId: 1, outcomes,
      statefulAncestorsByTarget: new WeakMap<HTMLElement, readonly Element[]>(), modal: null as any};
    session.statefulAncestorsByTarget.set(target, []);
    let current = true;
    const publish = vi.fn();
    const stop = bindFullPageOutcomeRecovery(session, () => current, publish);
    ports.listener!(unowned, {phase: 'error'});
    expect(publish).not.toHaveBeenCalled();
    outcomes.update(target, 'loading');
    ports.listener!(target, {phase: 'loading'});
    ports.listener!(target, {phase: 'translated'});
    ports.listener!(target, undefined);
    expect(outcomes.snapshot()).toEqual({loading: 0, completed: 0, failed: 0});
    outcomes.update(target, 'loading');
    ports.listener!(target, {phase: 'error'});
    outcomes.setRetry(target, () => true);
    expect(ports.action!('locate')).toBe(0); // The backing state disappeared.
    ports.states.set(target, {phase: 'translated'});
    expect(ports.action!('retry')).toBe(0);
    ports.states.set(target, {phase: 'error'});
    expect(ports.action!('locate')).toBe(1);
    expect(target.scrollIntoView).toHaveBeenCalledWith({block: 'center', behavior: 'auto'});
    session.modal = {};
    ports.within.mockReturnValue(false);
    expect(ports.action!('locate')).toBe(0);
    ports.within.mockReturnValue(true);
    expect(ports.action!('retry')).toBe(1);
    Object.assign(target, {isConnected: false});
    expect(ports.action!('retry')).toBe(0);
    ports.listener!(target, {phase: 'error'});
    expect(outcomes.snapshot().failed).toBe(0);
    current = false;
    const count = publish.mock.calls.length;
    ports.listener!(target, {phase: 'error'});
    expect(ports.action!('retry')).toBe(0);
    session.active = false;
    ports.listener!(target, {phase: 'error'});
    expect(ports.action!('locate')).toBe(0);
    expect(publish).toHaveBeenCalledTimes(count);
    stop(); expect(ports.stop).toHaveBeenCalledOnce();
  });
  it('重绑保留已登记失败回调，忽略旧悬浮错误和独立身份请求，摘要仅恢复当前弹窗', () => {
    const target = {isConnected: true, scrollIntoView: vi.fn()} as unknown as HTMLElement;
    const outcomes = createFullPageOutcomeRegistry<HTMLElement>();
    const session = {active: true, progressSessionId: 1, outcomes, statefulAncestorsByTarget: new WeakMap<HTMLElement, readonly Element[]>(), modal: null as any};
    ports.states.set(target, {phase: 'error', translationInvocationIdentity: 'owned'});
    registerFullPageOutcomeTarget(session, target, 'owned');
    expect(outcomes.has(target)).toBe(false);
    ports.states.set(target, {phase: 'loading', translationInvocationIdentity: 'owned'});
    registerFullPageOutcomeTarget(session, target, 'owned');
    expect(getFullPageOutcomeSummary(session).phases).toEqual(['loading', '', '']);
    ports.states.set(target, {phase: 'error', translationInvocationIdentity: 'owned'});
    registerFullPageOutcomeTarget(session, target, 'owned');
    const callback = vi.fn(() => true); outcomes.setRetry(target, callback);
    registerFullPageOutcomeTarget(session, target, 'owned');
    expect(outcomes.retry(() => true)).toBe(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(getFullPageOutcomeSummary(session)).toMatchObject({failed: 1, retryable: 1, phases: ['', 'error', '']});
    session.modal = {}; ports.within.mockReturnValue(false);
    expect(getFullPageOutcomeSummary(session).retryable).toBe(0);
    ports.states.set(target, {phase: 'translated', translationInvocationIdentity: 'owned'});
    registerFullPageOutcomeTarget(session, target, 'owned');
    expect(getFullPageOutcomeSummary(session).phases).toEqual(['', '', 'translated']);
    ports.states.set(target, {phase: 'loading', translationInvocationIdentity: 'foreign'});
    registerFullPageOutcomeTarget(session, target, 'owned');
    expect(outcomes.has(target)).toBe(false);
    Object.assign(target, {isConnected: false});
    registerFullPageOutcomeTarget(session, target, 'owned');
    ports.states.delete(target); Object.assign(target, {isConnected: true});
    registerFullPageOutcomeTarget(session, target, 'owned');
    expect(outcomes.snapshot()).toEqual({loading: 0, completed: 0, failed: 0});
  });

  it('弹窗惰性阶段只读取本会话当前身份且仍在弹窗内的目标', () => {
    const nodes = Array.from({length: 6}, () => ({isConnected: true}) as HTMLElement);
    const outcomes = createFullPageOutcomeRegistry<HTMLElement>();
    const session = {active: true, progressSessionId: 1, outcomes, statefulAncestorsByTarget: new WeakMap<HTMLElement, readonly Element[]>(), modal: {} as any};
    for (const node of nodes) outcomes.update(node, 'error');
    Object.assign(nodes[1], {isConnected: false});
    outcomes.update(nodes[2]);
    ports.within.mockImplementation(((_modal: unknown, node: HTMLElement) => node !== nodes[3]) as any);
    ports.states.set(nodes[0], {phase: 'translated', translationInvocationIdentity: 'owned'});
    ports.states.set(nodes[4], {phase: 'error', translationInvocationIdentity: 'foreign'});
    expect([...getFullPageModalOutcomePhases(session, nodes, 'owned')]).toEqual(['translated']);
    session.modal = null;
    expect([...getFullPageModalOutcomePhases(session, nodes, 'owned')]).toEqual([]);
    ports.within.mockReset(); ports.within.mockReturnValue(true);
  });
});

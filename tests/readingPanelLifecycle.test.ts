import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_HARNESS_PREFERENCES} from '@/src/core/config/harness';
import type {HarnessSession} from '@/src/services/harness/sessionTypes';
import type {ReadingRequest, ReadingProgress, ReadingResponse} from '@/src/features/reading-assistant/types';

const TEST_KEY = '__frReadingLifecycle';
interface StreamCall {
  request: ReadingRequest;
  callbacks: {progress: (value: ReadingProgress) => void; result: (value: ReadingResponse) => void; error: (error: Error) => void};
  cancel: ReturnType<typeof vi.fn>;
}
let server: ViteDevServer | undefined;
let unmount: (() => void) | undefined;
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');

afterEach(async () => {
  unmount?.(); unmount = undefined;
  await server?.close(); server = undefined;
  delete (globalThis as Record<string, unknown>)[TEST_KEY];
});

async function mountPanel(overrides: Record<string, unknown> = {}, sessions: HarnessSession[] = []) {
  const calls: StreamCall[] = [];
  const sendMessage = vi.fn(async () => ({success: true}));
  const state = {
    browser: {runtime: {sendMessage}},
    streamReading: (request: ReadingRequest, callbacks: StreamCall['callbacks']) => {
      const call = {request, callbacks, cancel: vi.fn()}; calls.push(call); return {cancel: call.cancel};
    },
    getHarnessSession: vi.fn(async (id: string) => sessions.find(session => session.id === id) || null),
    listHarnessSessions: vi.fn(async () => ({sessions: [], hasMore: false})),
    saveLearningMemory: vi.fn(async () => ({})),
  };
  (globalThis as Record<string, unknown>)[TEST_KEY] = state;
  const mocks: Plugin = {
    name: 'reading-lifecycle-mocks', enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'webextension-polyfill') return '\0reading-browser';
      if (id === '../client' && importer?.includes('/reading-assistant/ui/')) return '\0reading-client';
      return null;
    },
    load(id) {
      if (id === '\0reading-browser') return `export default globalThis.${TEST_KEY}.browser;`;
      if (id === '\0reading-client') return `export const {streamReading,getHarnessSession,listHarnessSessions,saveLearningMemory} = globalThis.${TEST_KEY};`;
      return null;
    },
  };
  server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(), plugins: [mocks, vue()], resolve: {alias: {'@': resolve(process.cwd())}}, server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill']}});
  const loaded = await server.ssrLoadModule('/src/features/reading-assistant/ui/ReadingPanel.vue');
  const component = loaded.default;
  component.ssrRender = undefined; component.render = () => null;
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp: () => undefined, insert: () => undefined, remove: () => undefined,
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText: () => undefined, setElementText: () => undefined, parentNode: () => null,
    nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
    cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
  });
  const sourceChange = vi.fn();
  const props = runtime.reactive({selection: {text: 'Practice helps.', sentence: 'Practice helps.', context: 'Practice helps every day.'}, preferences: {...DEFAULT_HARNESS_PREFERENCES, enabled: true}, active: true, targetLanguage: 'zh-CN', sourceLanguage: 'en', vocabularyEnabled: true, privateContext: false, animations: false, onSourceChange: sourceChange, ...overrides});
  let panel: any;
  const app = renderer.createApp({setup: () => () => runtime.h(component, {...props, ref: (instance: any) => { if (instance) panel = instance.$.setupState; }})});
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  app.mount({}); unmount = () => app.unmount();
  await runtime.nextTick();
  const finish = (text: string, call = calls.at(-1)!) => call.callbacks.result({success: true, text, service: 'deepseek', model: 'test-model', sessionId: 'session-a'});
  return {panel, calls, props, sendMessage, sourceChange, finish, state, tick: runtime.nextTick};
}

describe('reading action ownership and reuse', () => {
  it('restores each completed action and its follow-up context without requesting again; explicit regeneration requests once', async () => {
    const {panel, calls, finish} = await mountPanel();
    finish('Meaning answer');
    panel.startAction('practice'); finish('Practice answer');
    panel.question = 'My practice attempt'; panel.ask(); finish('Practice feedback');
    expect(calls.at(-1)!.request.history).toEqual([{question: '练习', answer: 'Practice answer'}]);
    panel.startAction('grammar'); finish('Grammar answer');
    panel.startAction('practice');
    expect(calls).toHaveLength(4);
    expect(panel.answer).toBe('Practice feedback');
    expect(panel.currentQuestion).toBe('My practice attempt');
    panel.startAction('practice'); expect(calls).toHaveLength(4);
    panel.question = 'One more question'; panel.ask();
    expect(calls.at(-1)!.request.history).toEqual([{question: '练习', answer: 'Practice answer'}, {question: 'My practice attempt', answer: 'Practice feedback'}]);
    finish('Second feedback'); panel.regenerate();
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)!.request).toMatchObject({intent: 'practice', question: '', history: []});
    finish('New practice');
    panel.startAction('meaning'); panel.startAction('practice');
    expect(calls).toHaveLength(6); expect(panel.answer).toBe('New practice');
    expect(panel.priorAnswers.every((turn: any) => turn.id !== panel.currentTurnKey)).toBe(true);
  });

  it('cancels switched requests, ignores late deltas, and keeps the last successful answer after a failed regeneration', async () => {
    const {panel, calls, finish} = await mountPanel();
    finish('Stable meaning'); panel.startAction('practice');
    const unfinished = calls.at(-1)!;
    unfinished.callbacks.progress({kind: 'text', text: 'Partial practice'});
    panel.startAction('meaning');
    expect(unfinished.cancel).toHaveBeenCalledOnce();
    unfinished.callbacks.progress({kind: 'text', text: 'Late practice'}); finish('Late finish', unfinished);
    expect(panel.answer).toBe('Stable meaning');
    panel.regenerate(); calls.at(-1)!.callbacks.result({success: false, error: 'Offline'});
    panel.startAction('practice'); finish('Good practice'); panel.startAction('meaning');
    expect(panel.answer).toBe('Stable meaning'); expect(panel.error).toBe('');
    expect(calls).toHaveLength(4);
  });

  it('invalidates answers for changed source context, language, and model settings', async () => {
    const {panel, props, calls, finish, tick} = await mountPanel();
    finish('Original'); panel.startAction('practice'); finish('Practice');
    props.selection = {...props.selection, context: 'Same words in a different paragraph.'}; await tick();
    panel.startAction('meaning'); expect(calls).toHaveLength(3); finish('New context');
    props.targetLanguage = 'ja'; await tick(); panel.startAction('meaning'); expect(calls).toHaveLength(4); finish('Japanese');
    Object.assign(props, {modelRevision: 1}); await tick(); panel.startAction('meaning'); expect(calls).toHaveLength(5);
  });

  it('restores completed actions from a saved session and does not include the failed answer in retry history', async () => {
    const session: HarnessSession = {id: 'old', text: 'Historical source.', context: 'Historical paragraph.', createdAt: 1, updatedAt: 4, intent: 'grammar', turns: [
      {id: 'a', question: '练习', answer: 'Saved practice', intent: 'practice', status: 'completed', model: 'old-model', service: 'deepseek', createdAt: 1},
      {id: 'b', question: '拆句', answer: 'Partial grammar', intent: 'grammar', status: 'error', model: 'old-model', service: 'deepseek', createdAt: 2},
    ]};
    const {panel, calls, sourceChange, tick} = await mountPanel({historyOnly: true}, [session]);
    await panel.restoreSession('old'); await tick();
    expect(calls).toHaveLength(0); expect(panel.answer).toBe('Partial grammar');
    expect(sourceChange).toHaveBeenCalledWith('Historical source.');
    panel.retry();
    expect(calls[0].request.history).toEqual([{question: '练习', answer: 'Saved practice'}]);
    panel.startAction('practice');
    expect(calls).toHaveLength(1); expect(panel.answer).toBe('Saved practice');
    expect(panel.activeText).toBe('Historical source.');
  });

  it('handles negative settings responses and allows saving original text before the model answers', async () => {
    const {panel, sendMessage, calls} = await mountPanel();
    sendMessage.mockResolvedValueOnce({success: false});
    await panel.openSettings('settings-services');
    expect(panel.feedback).toContain('翻译服务');
    sendMessage.mockRejectedValueOnce(new Error('background stopped'));
    await panel.openSettings(); expect(panel.feedback).toContain('专项翻译');
    await panel.openSettings(); expect(sendMessage).toHaveBeenLastCalledWith({type: 'openOptionsPage', section: 'settings-harness'});
    await panel.saveWord();
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({action: 'upsert', input: expect.objectContaining({term: 'Practice helps.', sourceLanguage: 'en', translation: ''})}));
    expect(panel.saved).toBe(true); expect(calls).toHaveLength(1);
  });
  it('only remembers completed answers after an explicit click with memory enabled outside private windows', async () => {
    const {panel, props, state, finish, tick} = await mountPanel();
    finish('A useful explanation'); await panel.rememberLearning();
    expect(state.saveLearningMemory).not.toHaveBeenCalled();
    props.preferences = {...props.preferences, memoryEnabled: true}; await tick();
    panel.regenerate(); await panel.rememberLearning();
    expect(state.saveLearningMemory).not.toHaveBeenCalled();
    finish('New useful explanation');
    expect(state.saveLearningMemory).not.toHaveBeenCalled();
    await panel.rememberLearning();
    expect(state.saveLearningMemory).toHaveBeenCalledWith({kind: 'lesson', content: '原文：Practice helps.\n学习要点：New useful explanation'});
    expect(panel.remembered).toBe(true);
    props.privateContext = true; await tick(); await panel.rememberLearning();
    expect(state.saveLearningMemory).toHaveBeenCalledOnce();
  });
});

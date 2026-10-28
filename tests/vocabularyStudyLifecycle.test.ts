import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {VocabularyEntry} from '@/src/features/vocabulary/learningModel';
import type {ReadingRequest, ReadingProgress, ReadingResponse} from '@/src/features/reading-assistant/types';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {DEFAULT_HARNESS_PREFERENCES, getHarnessModelCacheKey} from '@/src/core/config/harness';
import {getApiKeyRequirementKey, isApiKeyRequired} from '@/src/core/config/validation';

const KEY = '__frSentenceStudyLifecycle';
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
interface StreamCall {
  request: ReadingRequest;
  callbacks: {progress(value: ReadingProgress): void; result(value: ReadingResponse): void; error(error: Error): void};
  cancel: ReturnType<typeof vi.fn>;
}
type ConfigListener = (next: Config) => void;
interface ConfigChange {
  name: string;
  patch(current: Config): Partial<Config>;
}
const unrelatedConfigChanges: ConfigChange[] = [
  {name:'count', patch:current=>({count:current.count + 1})},
  {name:'theme', patch:current=>({theme:current.theme === 'dark' ? 'light' : 'dark'})},
  {name:'animations', patch:current=>({animations:!current.animations})},
  {name:'glossary', patch:current=>({glossaryEnabled:!current.glossaryEnabled})},
];
const relevantConfigChanges: ConfigChange[] = [
  {name:'on', patch:()=>({on:false})},
  {name:'target-language', patch:()=>({to:'ja'})},
  {name:'ui-language', patch:()=>({uiLanguage:'en-US'})},
  {name:'harness-enabled', patch:current=>({harness:{...current.harness,enabled:false}})},
  {name:'harness-context', patch:current=>({harness:{...current.harness,contextMode:'selection'}})},
  {name:'harness-memory', patch:current=>({harness:{...current.harness,memoryEnabled:true}})},
  {name:'harness-level', patch:current=>({harness:{...current.harness,learningLevel:'advanced'}})},
  {name:'harness-system-prompt', patch:current=>({harness:{...current.harness,systemPrompt:'Synthetic explicit instructions'}})},
  {name:'harness-action-prompt', patch:current=>({harness:{...current.harness,actionPrompts:{...current.harness.actionPrompts,usage:'Synthetic usage instructions'}}})},
  {name:'harness-actions', patch:current=>({harness:{...current.harness,actions:['meaning']}})},
  {name:'harness-model', patch:current=>({harness:{...current.harness,model:'deepseek-reasoner'}})},
  {name:'service', patch:()=>({service:'openai'})},
  {name:'active-credential', patch:current=>({apiKeys:{...current.apiKeys,deepseek:['synthetic-credential-change']}})},
  {name:'active-proxy', patch:current=>({proxy:{...current.proxy,deepseek:'https://synthetic.test/v1'}})},
  {name:'credential-recovery', patch:current=>({apiKeyRecoveryMs:current.apiKeyRecoveryMs + 60000})},
  {name:'require-credential', patch:current=>({requireApiKey:{...current.requireApiKey,[getApiKeyRequirementKey('deepseek',current)]:false}})},
  {name:'request-header-rules', patch:()=>({requestHeaderRules:[{domain:'synthetic.test',removeOrigin:true,removeReferer:false}]})},
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
let server: ViteDevServer | undefined;
let unmount: (() => void) | undefined;
afterEach(async () => {
  unmount?.(); unmount = undefined;
  await server?.close(); server = undefined;
  delete (globalThis as Record<string, unknown>)[KEY];
});

async function mountStudy(overrides: Partial<VocabularyEntry> = {}) {
  const calls: StreamCall[] = [];
  const entry: VocabularyEntry = {
    id:'sentence-a', kind:'sentence', term:'Good ideas deserve attention.', updatedAt:10,
    identityKey:'en:good ideas deserve attention.', sourceLanguage:'en', normalizedTerm:'good ideas deserve attention.', phonetic:'', partOfSpeech:'',
    createdAt:10, lastSeenAt:10, encounterCount:1, masteryLevel:0, status:'new', nextReviewAt:10, lastReviewedAt:null, reviewCount:0, lapseCount:0, schemaVersion:1,
    contexts:[{text:'Good ideas deserve attention. Practice makes progress.', capturedAt:10}],
    translations:{'zh-hans':{text:'好想法值得关注。', updatedAt:10}},
    ...overrides,
  };
  const props = runtime.reactive({entry, reference:'好想法值得关注。'});
  const sendMessage = vi.fn(async (message: {note: string}) => ({success:true, data:{...props.entry, note:message.note, noteUpdatedAt:11, updatedAt:11}}));
  const config = runtime.reactive(normalizeConfig({...new Config(),on:true,uiLanguage:'zh-CN',service:'deepseek',
    harness:{...DEFAULT_HARNESS_PREFERENCES,enabled:true}}));
  const listeners = new Set<ConfigListener>();
  // Same normalized snapshots and immediate delivery as the owning store, without storage I/O.
  const subscribeConfig = (listener: ConfigListener) => {
    listeners.add(listener); listener(normalizeConfig(config));
    return ()=>listeners.delete(listener);
  };
  const notifyConfig = (patch: Partial<Config>) => {
    Object.assign(config,normalizeConfig({...config,...patch}));
    const snapshot = normalizeConfig(config);
    listeners.forEach(listener=>listener(snapshot));
  };
  const state = {
    config, subscribeConfig,
    browser:{runtime:{sendMessage}},
    streamReading(request: ReadingRequest, callbacks: StreamCall['callbacks']) {
      const call = {request, callbacks, cancel:vi.fn()}; calls.push(call); return {cancel:call.cancel};
    },
  };
  (globalThis as Record<string, unknown>)[KEY] = state;
  const mocks: Plugin = {
    name:'sentence-study-lifecycle-mocks', enforce:'pre',
    resolveId(id) {
      if (id === 'webextension-polyfill') return '\0study-browser';
      if (/(?:@\/src|\/src)\/services\/config\/store(?:\.ts)?$/u.test(id)) return '\0study-config';
      if (/(?:@\/src|\/src)\/features\/reading-assistant\/(?:ui\/answer\/)?public(?:\.ts)?$/u.test(id)) return '\0study-reading';
      if (/(?:@\/src|\/src)\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0study-i18n';
      return null;
    },
    load(id) {
      if (id === '\0study-browser') return `export default globalThis.${KEY}.browser;`;
      if (id === '\0study-config') return `export const {config, subscribeConfig} = globalThis.${KEY};`;
      if (id === '\0study-reading') return `export const {streamReading} = globalThis.${KEY}; export const ReadingAnswer = {render:()=>null};`;
      if (id === '\0study-i18n') return 'export const useUiI18n=()=>({t:key=>key,translateLegacy:text=>text});';
      return null;
    },
  };
  server = await createServer({configFile:false, appType:'custom', logLevel:'silent', root:process.cwd(), plugins:[mocks,vue()], resolve:{alias:{'@':resolve(process.cwd())}}, server:{hmr:false,middlewareMode:true}, ssr:{noExternal:['webextension-polyfill']}});
  const loaded = await server.ssrLoadModule('/src/features/vocabulary/ui/VocabularyStudy.vue');
  const component = loaded.default; component.ssrRender = undefined; component.render = () => null;
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp:()=>undefined, insert:()=>undefined, remove:()=>undefined,
    createElement:()=>({}), createText:()=>({}), createComment:()=>({}),
    setText:()=>undefined, setElementText:()=>undefined, parentNode:()=>null,
    nextSibling:()=>null, querySelector:()=>null, setScopeId:()=>undefined,
    cloneNode:()=>({}), insertStaticContent:()=>[{},{}],
  });
  let panel: any;
  const updated = vi.fn((entry: VocabularyEntry) => {props.entry = entry;});
  const app = renderer.createApp({setup:()=>()=>runtime.h(component,{...props,onUpdated:updated,ref:(instance:any)=>{if(instance)panel=instance.$.setupState;}})});
  app.provide(runtime.ssrContextKey,{modules:new Set<string>()}); app.config.warnHandler=()=>undefined;
  app.mount({}); unmount=()=>app.unmount(); await runtime.nextTick();
  const finish = (text: string, call = calls.at(-1)!) => call.callbacks.result({success:true,text,service:'fixture',model:'fixture',sessionId:'study-a'});
  return {panel,props,calls,sendMessage,updated,finish,config,listeners,notifyConfig,tick:runtime.nextTick};
}

describe('saved sentence explanation lifecycle', () => {
  it('grounds an explicit Chinese expression request in its latest useful saved sentence and cancels it when that sentence changes', async () => {
    const contexts = [{text:'我每天学习中文。', capturedAt:10}, {text:'学习', capturedAt:11}, {text:'这是无关的原句。', capturedAt:12}];
    const {panel,props,calls,sendMessage,finish,tick} = await mountStudy({kind:'expression', term:'学习', sourceLanguage:'zh-CN', contexts});
    expect(calls).toHaveLength(0); expect(panel.context.text).toBe(contexts[0].text);
    panel.run('understand');
    expect(calls[0].request.selection).toEqual({text:'学习', context:'我每天学习中文。', sentence:''});
    expect(calls[0].request.studyMode).toBe('understand');
    props.entry = {...props.entry,contexts:[{text:'明天继续学习。', capturedAt:13}]}; await tick();
    expect(calls[0].cancel).toHaveBeenCalledOnce(); finish('Late previous explanation',calls[0]);
    expect(panel.explanation).toBe(''); expect(calls).toHaveLength(1);
    panel.run('understand'); expect(calls[1].request.selection.context).toBe('明天继续学习。');
    expect(sendMessage).not.toHaveBeenCalled(); expect(contexts.map(context=>context.text)).toEqual(['我每天学习中文。','学习','这是无关的原句。']);
  });
  it('generates only on demand and preserves reading while saving a separate note', async () => {
    const {panel,props,calls,sendMessage,finish,tick} = await mountStudy();
    expect(calls).toHaveLength(0); expect(sendMessage).not.toHaveBeenCalled();
    panel.run('understand'); expect(calls[0].request.studyMode).toBe('sentence');
    expect(calls[0].request.selection.text).toBe(props.entry.term);
    calls[0].callbacks.progress({kind:'text',text:'Partial explanation'});
    props.entry = {...props.entry,note:'My own note',updatedAt:11}; await tick();
    expect(panel.busy).toBe(true); expect(calls[0].cancel).not.toHaveBeenCalled();
    finish('A concise explanation.'); await tick();
    expect(sendMessage).not.toHaveBeenCalled();
    await panel.saveExplanation(); await tick();
    expect(sendMessage).toHaveBeenCalledWith({type:'fluentReadVocabularyBook',action:'updateNote',entryId:'sentence-a',note:'A concise explanation.'});
    expect(props.entry.note).toBe('A concise explanation.');
    expect(props.entry.translations['zh-hans'].text).toBe('好想法值得关注。');
    expect(panel.explanation).toBe('A concise explanation.'); expect(panel.completedExplanation).toBe(false);
    expect(panel.notice).toContain('解释已保存');
  });

  it('rejects late responses after a source changes and cannot save canceled or failed output', async () => {
    const {panel,props,calls,sendMessage,finish,tick} = await mountStudy();
    panel.run('understand'); const old = calls[0];
    old.callbacks.progress({kind:'text',text:'Old partial answer'});
    props.entry = {...props.entry,term:'Practice makes progress.'}; await tick();
    expect(old.cancel).toHaveBeenCalledOnce(); expect(panel.explanation).toBe('');
    finish('A late answer.',old); expect(panel.explanation).toBe('');
    panel.run('understand'); const stopped = calls[1];
    stopped.callbacks.progress({kind:'text',text:'Interrupted explanation'}); panel.stop();
    finish('A canceled answer.',stopped); await panel.saveExplanation();
    expect(panel.explanation).toBe('Interrupted explanation'); expect(sendMessage).not.toHaveBeenCalled();
    panel.run('understand'); calls[2].callbacks.result({success:false,error:'Fixture unavailable'});
    await panel.saveExplanation(); expect(sendMessage).not.toHaveBeenCalled(); expect(panel.error).toBe('Fixture unavailable');
    panel.run('understand'); const leaving = calls[3]; unmount?.(); unmount=undefined;
    expect(leaving.cancel).toHaveBeenCalledOnce(); finish('After unmount.',leaving);
    expect(panel.completedExplanation).toBe(false);
  });

  it.each(unrelatedConfigChanges)('keeps the active explanation and final answer across an unrelated $name notification', async change => {
    const {panel,calls,config,notifyConfig,finish,sendMessage} = await mountStudy();
    panel.run('understand'); const call = calls[0];
    call.callbacks.progress({kind:'text',text:'Current partial answer'});
    const modelKey = getHarnessModelCacheKey(config);
    notifyConfig(change.patch(config));
    expect(getHarnessModelCacheKey(config)).toBe(modelKey);
    expect(call.cancel).not.toHaveBeenCalled(); expect(panel.busy).toBe(true);
    expect(panel.notice).toBe(''); expect(calls).toHaveLength(1);
    call.callbacks.progress({kind:'text',text:'Current answer continues'});
    expect(panel.explanation).toBe('Current answer continues');
    finish('Current complete answer',call);
    expect(panel.busy).toBe(false); expect(panel.completedExplanation).toBe(true);
    expect(panel.explanation).toBe('Current complete answer'); expect(sendMessage).not.toHaveBeenCalled();
  }, 15_000); // Each case starts and transforms a fresh Vite server; shared CI resources can delay startup.

  it.each(relevantConfigChanges)('invalidates current stream ownership for a real $name input change', async change => {
    const {panel,calls,config,notifyConfig,finish} = await mountStudy();
    panel.run('understand'); const call = calls[0];
    call.callbacks.progress({kind:'text',text:'Old partial answer'});
    if (change.name === 'require-credential') expect(isApiKeyRequired('deepseek',config)).toBe(true);
    notifyConfig(change.patch(config));
    if (change.name === 'require-credential') expect(isApiKeyRequired('deepseek',config)).toBe(false);
    expect(call.cancel).toHaveBeenCalledOnce(); expect(panel.busy).toBe(false);
    expect(panel.notice).toContain('设置已更新'); expect(calls).toHaveLength(1);
    call.callbacks.progress({kind:'text',text:'Late obsolete delta'}); finish('Late obsolete answer',call);
    call.callbacks.error(new Error('Late obsolete failure'));
    expect(panel.explanation).toBe('Old partial answer'); expect(panel.completedExplanation).toBe(false); expect(panel.error).toBe('');
    if (change.name === 'on' || change.name === 'harness-enabled') expect(panel.enabled).toBe(false);
    if (change.name === 'harness-context') expect(panel.contextAllowed).toBe(false);
  });

  it('leaves an active stream unchanged for repeated identical normalized snapshots', async () => {
    const {panel,calls,notifyConfig,finish} = await mountStudy();
    panel.run('understand'); const call = calls[0];
    notifyConfig({}); notifyConfig({});
    expect(call.cancel).not.toHaveBeenCalled(); expect(panel.busy).toBe(true); expect(panel.notice).toBe('');
    finish('Same snapshot answer',call); expect(panel.completedExplanation).toBe(true);
  });

  it('waits for a new explicit action after a relevant update and uses the latest context permission', async () => {
    const {panel,calls,config,notifyConfig,finish} = await mountStudy();
    panel.run('understand'); const old = calls[0];
    expect(old.request.selection.context).not.toBe('');
    notifyConfig({harness:{...config.harness,contextMode:'selection'}});
    expect(calls).toHaveLength(1); expect(old.cancel).toHaveBeenCalledOnce();
    notifyConfig({}); expect(old.cancel).toHaveBeenCalledOnce();
    panel.run('understand'); const latest = calls[1];
    expect(latest.request.selection.context).toBe(''); expect(latest.request.requestId).not.toBe(old.request.requestId);
    finish('Late old answer',old); expect(panel.explanation).toBe(''); expect(panel.busy).toBe(true);
    finish('Latest authorized answer',latest); expect(panel.explanation).toBe('Latest authorized answer'); expect(panel.completedExplanation).toBe(true);
  });

  it('unsubscribes on unmount and preserves cancellation against later config and stream callbacks', async () => {
    const {panel,calls,listeners,notifyConfig,finish} = await mountStudy();
    expect(listeners.size).toBe(1); panel.run('understand'); const leaving = calls[0];
    leaving.callbacks.progress({kind:'text',text:'Before leaving'});
    unmount?.(); unmount=undefined;
    expect(listeners.size).toBe(0); expect(leaving.cancel).toHaveBeenCalledOnce();
    const notice = panel.notice;
    notifyConfig({on:false}); leaving.callbacks.progress({kind:'text',text:'After leaving'}); finish('Late leaving answer',leaving);
    expect(leaving.cancel).toHaveBeenCalledOnce(); expect(panel.explanation).toBe('Before leaving'); expect(panel.completedExplanation).toBe(false);
    expect(panel.notice).toBe(notice); expect(calls).toHaveLength(1);
  });

  it.each(unrelatedConfigChanges.slice(0,2))('preserves the pending save owner across an unrelated $name notification', async change => {
    const {panel,props,calls,config,notifyConfig,finish,sendMessage,updated,tick} = await mountStudy();
    panel.run('understand'); finish('Completed explanation to save');
    const response = {success:true,data:{...props.entry,note:'Completed explanation to save',noteUpdatedAt:12,updatedAt:12}};
    const gate = deferred<Awaited<ReturnType<typeof sendMessage>>>(); sendMessage.mockReturnValueOnce(gate.promise);
    const saving = panel.saveExplanation() as Promise<void>;
    try {
      expect(panel.savingExplanation).toBe(true); expect(updated).not.toHaveBeenCalled();
      notifyConfig(change.patch(config)); expect(calls).toHaveLength(1);
      gate.resolve(response); await saving; await tick();
      expect(updated).toHaveBeenCalledOnce(); expect(props.entry.note).toBe('Completed explanation to save');
      expect(panel.notice).toContain('解释已保存'); expect(panel.completedExplanation).toBe(false); expect(panel.savingExplanation).toBe(false);
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {gate.resolve(response); await saving;}
  });

  it.each(relevantConfigChanges.filter(change=>change.name === 'target-language' || change.name === 'harness-context'))('rejects a pending save result after a real $name input change', async change => {
    const {panel,props,config,notifyConfig,finish,sendMessage,updated,tick} = await mountStudy();
    panel.run('understand'); finish('Completed old explanation');
    const response = {success:true,data:{...props.entry,note:'Completed old explanation',noteUpdatedAt:12,updatedAt:12}};
    const gate = deferred<Awaited<ReturnType<typeof sendMessage>>>(); sendMessage.mockReturnValueOnce(gate.promise);
    const saving = panel.saveExplanation() as Promise<void>;
    try {
      notifyConfig(change.patch(config)); expect(panel.notice).toContain('设置已更新');
      gate.resolve(response); await saving; await tick();
      expect(updated).not.toHaveBeenCalled(); expect(props.entry.note).toBeUndefined();
      expect(panel.notice).toContain('设置已更新'); expect(panel.savingExplanation).toBe(false); expect(sendMessage).toHaveBeenCalledOnce();
    } finally {gate.resolve(response); await saving;}
  });
});

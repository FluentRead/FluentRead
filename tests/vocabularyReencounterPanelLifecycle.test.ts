import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Component} from 'vue';
import type {ReadingRequest, ReadingProgress, ReadingResponse} from '@/src/features/reading-assistant/types';
import type {ReencounterOccurrence} from '@/src/features/vocabulary/content/readingText';
import type {ReencounterState} from '@/src/features/vocabulary/content/reencounterState';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {DEFAULT_HARNESS_PREFERENCES, getHarnessModelCacheKey} from '@/src/core/config/harness';
import {getApiKeyRequirementKey, isApiKeyRequired} from '@/src/core/config/validation';

const KEY = '__frReencounterPanelLifecycle';
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
interface StreamCall {
  request: ReadingRequest;
  callbacks: {progress(value: ReadingProgress): void; result(value: ReadingResponse): void; error(error: Error): void};
  cancel: ReturnType<typeof vi.fn>;
}
interface PanelSetup {
  answer: string; busy: boolean; error: string; notice: string;
  dark: boolean; canExplain: boolean; contextAllowed: boolean;
  explain(): void; stop(): void;
}
interface ConfigChange {name: string; patch(current: Config): Partial<Config>}
const unrelatedConfigChanges: ConfigChange[] = [
  {name:'count', patch:current=>({count:current.count + 1})},
  {name:'theme', patch:()=>({theme:'dark'})},
  {name:'animations', patch:current=>({animations:!current.animations})},
  {name:'glossary', patch:current=>({glossaryEnabled:!current.glossaryEnabled})},
  {name:'identical-snapshot', patch:()=>({})},
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

// Owned DOM ports exercise setup/unmount listeners without claiming native focus or layout coverage.
class OwnedTarget {
  readonly listeners = new Set<{type: string; callback: EventListenerOrEventListenerObject}>();
  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (!callback || (typeof options === 'object' && options.signal?.aborted)) return;
    const record = {type,callback}; this.listeners.add(record);
    if (typeof options === 'object') options.signal?.addEventListener('abort',()=>this.listeners.delete(record),{once:true});
  }
  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    for (const record of this.listeners) if (record.type === type && record.callback === callback) this.listeners.delete(record);
  }
}
interface MountScope {
  disposed: boolean;
  key: string;
  server?: ViteDevServer;
  unmount?: () => void;
  assertClean?: () => void;
  restoreGlobals?: () => void;
  context?: unknown;
}
let currentScope: MountScope | undefined;
let nextScopeId = 0;
async function cleanupHarness() {
  const scope = currentScope;
  if (!scope) return;
  currentScope = undefined;
  scope.disposed = true;
  try {
    try {scope.unmount?.(); scope.unmount = undefined;}
    finally {
      // Restore this mount's globals before yielding so a later mount captures the original baseline.
      if ((globalThis as Record<string, unknown>)[scope.key] === scope.context) delete (globalThis as Record<string, unknown>)[scope.key];
      scope.restoreGlobals?.();
    }
    await runtime.nextTick(); scope.assertClean?.();
  } finally {
    await scope.server?.close();
  }
}
afterEach(cleanupHarness);

async function mountPanel(createServerImpl: typeof createServer = createServer, flush:()=>Promise<void> = () => runtime.nextTick()) {
  const scope: MountScope = {disposed:false,key:`${KEY}_${++nextScopeId}`};
  currentScope = scope;
  const calls: StreamCall[] = [];
  const media = Object.assign(new OwnedTarget(),{matches:false});
  const viewport = Object.assign(new OwnedTarget(),{width:1280,height:800,offsetLeft:0,offsetTop:0});
  const documentPort = Object.assign(new OwnedTarget(),{activeElement:null});
  const windowPort = Object.assign(new OwnedTarget(),{matchMedia:()=>media,visualViewport:viewport,innerWidth:1280,innerHeight:800});
  const ports = {document:documentPort,window:windowPort};
  const descriptors = new Map(Object.keys(ports).map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  scope.restoreGlobals = () => {
    for (const [name,descriptor] of descriptors) {
      // A newer mount may already own this global if cleanup overlaps its setup.
      if ((globalThis as Record<string, unknown>)[name] !== ports[name as keyof typeof ports]) continue;
      if (descriptor) Object.defineProperty(globalThis,name,descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  for (const [name,value] of Object.entries(ports)) Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  const occurrence = {
    entry:{id:'expression-a',term:'art',sourceLanguage:'en',reference:'Saved reference',savedSentence:'Old art sentence.',savedTitle:'Saved page'},
    sentence:'Art matters here.',ranges:[],root:documentPort,
  } as unknown as ReencounterOccurrence;
  const state = runtime.shallowReactive<ReencounterState>({occurrences:[occurrence],current:occurrence,saved:{...occurrence.entry},loading:false,error:'',paused:false});
  const config = runtime.reactive(normalizeConfig({...new Config(),on:true,uiLanguage:'zh-CN',service:'deepseek',theme:'light',vocabularyReencounterEnabled:true,
    harness:{...DEFAULT_HARNESS_PREFERENCES,enabled:true}}));
  const listeners = new Set<(next: Config) => void>();
  // Match the store's normalized, immediately delivered snapshots without browser storage I/O.
  const subscribeConfig = (listener: (next: Config) => void) => {
    listeners.add(listener); listener(normalizeConfig(config)); return ()=>listeners.delete(listener);
  };
  const notifyConfig = (patch: Partial<Config>) => {
    Object.assign(config,normalizeConfig({...config,...patch}));
    const snapshot = normalizeConfig(config); listeners.forEach(listener=>listener(snapshot));
  };
  const sendMessage = vi.fn(async () => ({success:true}));
  scope.context = {
    config,subscribeConfig,browser:{runtime:{sendMessage}},
    streamReading(request: ReadingRequest, callbacks: StreamCall['callbacks']) {
      const call = {request,callbacks,cancel:vi.fn()}; calls.push(call); return {cancel:call.cancel};
    },
  };
  (globalThis as Record<string, unknown>)[scope.key] = scope.context;
  const mocks: Plugin = {
    name:'reencounter-panel-lifecycle-ports',enforce:'pre',
    resolveId(id) {
      if (id === 'webextension-polyfill') return '\0reencounter-browser';
      if (/(?:@\/src|\/src)\/services\/config\/store(?:\.ts)?$/u.test(id)) return '\0reencounter-config';
      if (/(?:@\/src|\/src)\/features\/reading-assistant\/(?:ui\/answer\/)?public(?:\.ts)?$/u.test(id)) return '\0reencounter-reading';
      if (/(?:@\/src|\/src)\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0reencounter-i18n';
      return null;
    },
    load(id) {
      if (id === '\0reencounter-browser') return `export default globalThis[${JSON.stringify(scope.key)}].browser;`;
      if (id === '\0reencounter-config') return `export const {config,subscribeConfig}=globalThis[${JSON.stringify(scope.key)}];`;
      if (id === '\0reencounter-reading') return `export const {streamReading}=globalThis[${JSON.stringify(scope.key)}];export const ReadingAnswer={render:()=>null};`;
      if (id === '\0reencounter-i18n') return 'export const useUiI18n=()=>({t:key=>key,translateLegacy:text=>text});';
      return null;
    },
  };
  const server = await createServerImpl({configFile:false,appType:'custom',logLevel:'silent',root:process.cwd(),plugins:[mocks,vue()],resolve:{alias:{'@':resolve(process.cwd())}},server:{hmr:false,middlewareMode:true},ssr:{noExternal:['webextension-polyfill']}});
  if (scope.disposed) {await server.close(); throw Error('Panel mount was disposed');}
  scope.server = server;
  const loaded = await server.ssrLoadModule('/src/features/vocabulary/ui/ReencounterPanel.vue');
  if (scope.disposed) throw Error('Panel mount was disposed');
  const component = loaded.default as Component & {ssrRender?: undefined; render: () => null};
  component.ssrRender = undefined; component.render = () => null;
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp:()=>undefined,insert:()=>undefined,remove:()=>undefined,
    createElement:()=>({}),createText:()=>({}),createComment:()=>({}),
    setText:()=>undefined,setElementText:()=>undefined,parentNode:()=>null,
    nextSibling:()=>null,querySelector:()=>null,setScopeId:()=>undefined,
    cloneNode:()=>({}),insertStaticContent:()=>[{},{}],
  });
  let panel!: PanelSetup;
  const app = renderer.createApp({setup:()=>()=>runtime.h(component,{
    state,open:(next: ReencounterOccurrence)=>{state.current=next;},close:()=>{state.current=null;},
    pause:()=>{state.paused=true;state.current=null;},disable:()=>undefined,retry:()=>undefined,
    ref:(instance: unknown)=>{if (instance) panel=(instance as {$:{setupState:PanelSetup}}).$.setupState;},
  })});
  app.provide(runtime.ssrContextKey,{modules:new Set<string>()}); app.config.warnHandler=()=>undefined;
  scope.unmount = () => app.unmount();
  scope.assertClean = () => {
    expect(listeners.size).toBe(0); expect(media.listeners.size).toBe(0);
    expect(documentPort.listeners.size).toBe(0); expect(windowPort.listeners.size).toBe(0); expect(viewport.listeners.size).toBe(0);
  };
  app.mount({}); await flush();
  if (scope.disposed) throw Error('Panel mount was disposed');
  const finish = (text: string, call = calls.at(-1)!) => call.callbacks.result({success:true,text,service:'fixture',model:'fixture',sessionId:'reencounter-a'});
  const late = (call: StreamCall) => {
    call.callbacks.progress({kind:'text',text:'Late obsolete delta'}); finish('Late obsolete answer',call);
    call.callbacks.error(new Error('Late obsolete failure'));
  };
  return {panel,state,calls,config,listeners,notifyConfig,sendMessage,finish,late,tick:runtime.nextTick};
}

describe('reencounter explanation configuration and owner lifecycle', () => {
  it('restores globals when a new mount overlaps the previous server close', async () => {
    const names = ['document','window'] as const;
    const baseline = new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
    await mountPanel();
    const oldServer = currentScope!.server!, close = oldServer.close.bind(oldServer);
    let release!:()=>void, markReady!:()=>void;
    const gate = new Promise<void>(done=>{release=done;});
    const ready = new Promise<void>(done=>{markReady=done;});
    oldServer.close = async()=>{markReady(); await gate; await close();};
    const oldCleanup = cleanupHarness();
    try {
      await ready;
      const live = await mountPanel();
      release(); await oldCleanup;
      live.panel.explain(); expect(live.calls).toHaveLength(1);
      await cleanupHarness();
      for (const name of names) expect(Object.getOwnPropertyDescriptor(globalThis,name)).toEqual(baseline.get(name));
    } finally {
      release(); await Promise.allSettled([oldCleanup]); await cleanupHarness();
      for (const [name,descriptor] of baseline) {
        if (descriptor) Object.defineProperty(globalThis,name,descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  }, 20000);
  it.each(['createServer','ssrLoadModule','nextTick'] as const)('closes a disposed mount delayed in %s without affecting the next mount', async stage => {
    let release!:()=>void, markReady!:()=>void;
    const gate = new Promise<void>(done=>{release=done;});
    const ready = new Promise<void>(done=>{markReady=done;});
    let close!:ReturnType<typeof vi.spyOn>;
    const factory: typeof createServer = async options => {
      const created = await createServer(options);
      close = vi.spyOn(created,'close');
      if (stage === 'createServer') {markReady(); await gate;}
      else if (stage === 'ssrLoadModule') {
        const load = created.ssrLoadModule.bind(created);
        created.ssrLoadModule = async (...args) => {const result = await load(...args); markReady(); await gate; return result;};
      }
      return created;
    };
    const stale = mountPanel(factory, async () => {
      await runtime.nextTick();
      if (stage === 'nextTick') {markReady(); await gate;}
    });
    const staleScope = currentScope!;
    const rejection = expect(stale).rejects.toThrow('Panel mount was disposed');
    try {
      await ready;
      // Model afterEach running when Vitest has timed out the old test.
      await cleanupHarness();
      const live = await mountPanel();
      const liveScope = currentScope!;
      const liveContext = (globalThis as Record<string, unknown>)[liveScope.key];
      release(); await rejection;
      expect(close).toHaveBeenCalledOnce();
      expect((globalThis as Record<string, unknown>)[staleScope.key]).toBeUndefined();
      expect((globalThis as Record<string, unknown>)[liveScope.key]).toBe(liveContext);
      expect(currentScope).toBe(liveScope);
      live.panel.explain(); expect(live.calls).toHaveLength(1);
      expect(live.listeners.size).toBe(1);
    } finally {release(); await Promise.allSettled([stale]);}
  }, 20000);
  it('requests only on explicit action using the actual current sentence and preserves the saved reference', async () => {
    const {panel,state,calls,sendMessage,finish} = await mountPanel();
    expect(calls).toHaveLength(0); expect(panel.canExplain).toBe(true);
    const saved = state.saved;
    panel.explain(); expect(calls).toHaveLength(1);
    expect(calls[0].request.intent).toBe('usage');
    expect(calls[0].request.selection).toEqual({text:'art',context:'Art matters here.',sentence:''});
    finish('Explicit complete answer');
    expect(panel.answer).toBe('Explicit complete answer'); expect(panel.busy).toBe(false);
    expect(state.saved).toBe(saved); expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(unrelatedConfigChanges)('keeps the current explanation across an unrelated $name notification', async change => {
    const {panel,state,calls,config,notifyConfig,finish,sendMessage} = await mountPanel();
    panel.explain(); const call = calls[0]; const selected = state.current; const saved = state.saved;
    call.callbacks.progress({kind:'text',text:'Current partial answer'});
    const modelKey = getHarnessModelCacheKey(config); notifyConfig(change.patch(config));
    expect(getHarnessModelCacheKey(config)).toBe(modelKey);
    if (change.name === 'theme') expect(panel.dark).toBe(true);
    expect(call.cancel).not.toHaveBeenCalled(); expect(panel.busy).toBe(true); expect(panel.notice).toBe('');
    expect(state.current).toBe(selected); expect(state.saved).toBe(saved); expect(calls).toHaveLength(1);
    call.callbacks.progress({kind:'text',text:'Current answer continues'}); expect(panel.answer).toBe('Current answer continues');
    finish('Current complete answer',call);
    expect(panel.answer).toBe('Current complete answer'); expect(panel.busy).toBe(false); expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(relevantConfigChanges)('invalidates the active request for a real $name input change', async change => {
    const {panel,state,calls,config,notifyConfig,late} = await mountPanel();
    panel.explain(); const call = calls[0]; const selected = state.current; const saved = state.saved;
    call.callbacks.progress({kind:'text',text:'Old partial answer'});
    const previousRecovery = config.apiKeyRecoveryMs;
    if (change.name === 'require-credential') expect(isApiKeyRequired('deepseek',config)).toBe(true);
    notifyConfig(change.patch(config));
    if (change.name === 'require-credential') expect(isApiKeyRequired('deepseek',config)).toBe(false);
    if (change.name === 'credential-recovery') expect(config.apiKeyRecoveryMs).toBe(previousRecovery + 60000);
    expect(call.cancel).toHaveBeenCalledOnce(); expect(panel.busy).toBe(false); expect(panel.notice).toBe('reencounter.stopped');
    expect(calls).toHaveLength(1); late(call);
    expect(panel.answer).toBe('Old partial answer'); expect(panel.error).toBe(''); expect(panel.notice).toBe('reencounter.stopped');
    expect(state.current).toBe(selected); expect(state.saved).toBe(saved);
    if (['on','harness-enabled','harness-context','harness-actions'].includes(change.name)) expect(panel.canExplain).toBe(false);
    if (change.name === 'harness-context') expect(panel.contextAllowed).toBe(false);
  });

  it('waits for a second explicit action after a relevant update and keeps obsolete callbacks out of the new request', async () => {
    const {panel,calls,config,notifyConfig,finish,late} = await mountPanel();
    panel.explain(); const old = calls[0]; old.callbacks.progress({kind:'text',text:'Old answer'});
    notifyConfig({harness:{...config.harness,learningLevel:'advanced'}});
    expect(old.cancel).toHaveBeenCalledOnce(); expect(calls).toHaveLength(1); expect(panel.busy).toBe(false);
    panel.explain(); const latest = calls[1]; expect(latest.request.requestId).not.toBe(old.request.requestId);
    expect(panel.answer).toBe(''); expect(panel.busy).toBe(true); late(old);
    expect(panel.answer).toBe(''); expect(panel.error).toBe(''); expect(panel.notice).toBe(''); expect(panel.busy).toBe(true);
    finish('Latest explicit answer',latest); expect(panel.answer).toBe('Latest explicit answer'); expect(panel.busy).toBe(false);
  });

  it('preserves stop and unmount ownership and removes configuration and browser listeners', async () => {
    const {panel,calls,listeners,notifyConfig,late} = await mountPanel();
    panel.explain(); const stopped = calls[0]; stopped.callbacks.progress({kind:'text',text:'Stopped partial answer'}); panel.stop(); late(stopped);
    expect(stopped.cancel).toHaveBeenCalledOnce(); expect(panel.answer).toBe('Stopped partial answer'); expect(panel.error).toBe('');
    panel.explain(); const leaving = calls[1]; leaving.callbacks.progress({kind:'text',text:'Before leaving'});
    expect(listeners.size).toBe(1); currentScope?.unmount?.(); if(currentScope)currentScope.unmount=undefined;
    expect(listeners.size).toBe(0); expect(leaving.cancel).toHaveBeenCalledOnce(); const notice = panel.notice;
    notifyConfig({on:false}); late(leaving);
    expect(leaving.cancel).toHaveBeenCalledOnce(); expect(panel.answer).toBe('Before leaving'); expect(panel.error).toBe(''); expect(panel.notice).toBe(notice);
    expect(calls).toHaveLength(2);
  });

  it('cancels when the current occurrence changes and uses the newly selected sentence on the next explicit action', async () => {
    const {panel,state,calls,tick,late,finish} = await mountPanel();
    panel.explain(); const old = calls[0]; old.callbacks.progress({kind:'text',text:'Old sentence answer'});
    const next = {...state.current!,entry:{...state.current!.entry,id:'expression-b',term:'design'},sentence:'Design serves readers.'};
    state.occurrences=[next]; state.current=next; await tick();
    expect(old.cancel).toHaveBeenCalledOnce(); expect(panel.answer).toBe(''); expect(panel.busy).toBe(false); late(old);
    expect(panel.answer).toBe(''); expect(panel.error).toBe(''); expect(calls).toHaveLength(1);
    panel.explain(); expect(calls[1].request.selection).toEqual({text:'design',context:'Design serves readers.',sentence:''});
    finish('New sentence answer'); expect(panel.answer).toBe('New sentence answer');
  });
});

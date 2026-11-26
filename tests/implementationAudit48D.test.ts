import {translationSnapshot, ttsPreparation} from './helpers/localInferenceFixtures';
import {LOCAL_TRANSLATION_MODEL_IDS} from '@/src/core/config/localTranslation';
import type {LocalTtsPreparation, LocalTtsStatus} from '@/src/core/messaging/offscreen';
/**
 * @file tests/implementationAudit48D.test.ts
 * 文件职责：经真实公开入口审查 D 组离屏模型、Worker 释放、状态写入和 WAV 输出。
 * 主要内容：使用受控 Cache Storage、Worker、Kokoro 与浏览器消息端口执行生产逻辑；baseline 对照由私有配置切换原生产文件。
 * 模块边界：不复制生产算法、不访问网络或账号，也不暴露私有 helper。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {LOCAL_TTS_MODEL_ID, LOCAL_TTS_MODEL_STATE_KEY, LOCAL_TTS_MODEL_CACHE_NAME, LOCAL_TTS_VOICE_CACHE_NAME} from '@/src/core/config/localTts';

const external = vi.hoisted(() => ({fromPretrained: vi.fn(), env: {backends: {onnx: {} as {wasm?: object}}, fetch: undefined as unknown as typeof fetch, useBrowserCache: true}}));
vi.mock('@uzen/kokoro-js', () => ({KokoroTTS: {from_pretrained: external.fromPretrained}, env: {}}));
vi.mock('@huggingface/transformers-kokoro', () => ({env: external.env}));

const evidence = process.env.AUDIT48D_EVIDENCE_ROOT;
if (evidence) mkdirSync(evidence, {recursive: true});
const nativeFetch = globalThis.fetch;
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
async function flush() {for (let n = 0; n < 100; n++) await Promise.resolve();}
function cacheFixture() {
 const maps = new Map<string, Map<string, Response>>();
 const puts: string[] = [];
 const key = (url: RequestInfo | URL) => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
 const caches = {open: vi.fn(async (name: string) => {
  let entries = maps.get(name); if (!entries) {entries = new Map(); maps.set(name, entries);}
  return {
   match: vi.fn(async (url: RequestInfo | URL) => entries!.get(key(url))?.clone()),
   put: vi.fn(async (url: RequestInfo | URL, response: Response) => {
    // Cache.put 完成须已消费完整响应体，后台下载才能释放 reader；写入前失败不留下缓存。
    const body = new Uint8Array(await response.arrayBuffer());
    entries!.set(key(url), new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers}));
    puts.push(key(url));
   }),
   delete: vi.fn(async (url: RequestInfo | URL) => entries!.delete(key(url))),
  };
 })};
 vi.stubGlobal('caches', caches);
 vi.stubGlobal('self', {setTimeout, clearTimeout});
 return {maps, puts, caches};
}
async function seeded(fixture: ReturnType<typeof cacheFixture>, options: {mainOnly?: boolean; status?: number; marker?: string} = {}) {
 const cache = await import('@/src/features/local-tts/offscreen/modelCache');
 const model = await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME);
 const voice = await fixture.caches.open(LOCAL_TTS_VOICE_CACHE_NAME);
 for (const file of cache.LOCAL_TTS_MODEL_FILES) {
  const url = options.mainOnly ? cache.getLocalTtsModelLoaderUrl(file) : cache.getLocalTtsModelFileUrl(file);
  await model.put(url, new Response('pinned-' + file, {status: options.status || 200, headers: options.marker ? {'X-FluentRead-Model-Source': options.marker} : {}}));
 }
 for (const id of cache.LOCAL_TTS_VOICES) await voice.put(cache.getLocalTtsVoiceCacheUrl(id), new Response('voice'));
 fixture.puts.length = 0;
 return cache;
}
class WorkerPort {
 static instances: WorkerPort[] = [];
 onmessage: ((event: MessageEvent) => void) | null = null;
 onerror: ((event: ErrorEvent) => void) | null = null;
 messages: Array<Record<string, any>> = [];
 terminated = false;
 constructor() {WorkerPort.instances.push(this);}
 postMessage(message: Record<string, any>) {this.messages.push(message);}
 terminate() {this.terminated = true;}
 reply(response: Record<string, unknown>) {this.onmessage?.({data: {requestId: this.messages.at(-1)!.requestId, ...response}} as MessageEvent);}
}
async function owner() {
 const fixture = cacheFixture(); await seeded(fixture);
 vi.stubGlobal('window', {setTimeout, clearTimeout, location: {href: 'chrome-extension://fixture/offscreen.html'}});
 vi.stubGlobal('Worker', WorkerPort);
 return {fixture, api: await import('@/src/features/local-tts/offscreen/tts')};
}
async function startWorker(stream: () => AsyncGenerator<unknown>) {
 const scope = {location: {href: 'chrome-extension://fixture/localTtsWorker.js'}, onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn()};
 vi.stubGlobal('self', scope);
 vi.stubGlobal('navigator', {});
 external.fromPretrained.mockResolvedValue({stream, model: {dispose: vi.fn()}});
 const app = await import('@/src/app/offscreen/localTtsWorker'); app.startLocalTtsWorkerApp();
 if (process.env.AUDIT48D_PROBE === '1') console.info('AUDIT48D_MODULE_LOADED:src/features/local-tts/offscreen/tts.worker.ts');
 return {scope, send: async (request: Record<string, unknown>) => {
  const count = scope.postMessage.mock.calls.length + 1;
  scope.onmessage!({data: request} as MessageEvent);
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledTimes(count), {timeout: 2000, interval: 5});
  return scope.postMessage.mock.calls.at(-1)![0] as Record<string, any>;
 }};
}
beforeEach(() => {
 vi.resetModules(); external.fromPretrained.mockReset(); external.env.useBrowserCache = true; external.env.backends.onnx.wasm=undefined; WorkerPort.instances = [];
 vi.stubGlobal('navigator', {language: 'en-US'});
 vi.stubGlobal('fetch',vi.fn(async () => {throw new Error('controlled fixture: external fetch unavailable');}));
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); globalThis.fetch = nativeFetch; vi.clearAllTimers(); vi.useRealTimers();});

describe('audit48D cache public lifecycle', () => {
 it('status reads pinned files without writing loader aliases', async () => {
  const fixture = cacheFixture(); const api = await seeded(fixture);
  await expect(api.isLocalTtsModelCached()).resolves.toBe(true);
  expect(fixture.puts).toEqual([]);
 });
 it('does not label unowned main-only model files as the pinned download', async () => {
  const fixture = cacheFixture(); const api = await seeded(fixture, {mainOnly: true});
  await expect(api.isLocalTtsModelCached()).resolves.toBe(false);
 });
 it('does not accept cached HTTP failure bodies as complete models', async () => {
  const fixture = cacheFixture(); const api = await seeded(fixture, {status: 503});
  await expect(api.isLocalTtsModelCached()).resolves.toBe(false);
 });
 it('prepare preserves the qualified pinned response over a wrong-version loader alias without rewriting unowned bytes', async () => {
  const fixture = cacheFixture(); const api = await seeded(fixture);
  const model = await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME);
  for (const file of api.LOCAL_TTS_MODEL_FILES) {
   const pinned = api.getLocalTtsModelFileUrl(file);
   await model.put(pinned, new Response('pinned-' + file, {headers: {'X-FluentRead-Model-Source': pinned.replace('https://huggingface.co/', 'https://hf-mirror.net/')}}));
   await model.put(api.getLocalTtsModelLoaderUrl(file), new Response('other-revision', {headers: {'X-FluentRead-Model-Source': 'https://fixture.invalid/old'}}));
  }
  fixture.puts.length = 0;
  const fetchPort = vi.fn(async () => {throw new Error('unexpected network');}); vi.stubGlobal('fetch', fetchPort);
  await api.cacheLocalTtsModelFiles();
  for (const file of api.LOCAL_TTS_MODEL_FILES) {
   const pinned = await model.match(api.getLocalTtsModelFileUrl(file));
   expect(await pinned!.text()).toBe('pinned-' + file);
   expect(pinned!.headers.get('X-FluentRead-Model-Source')).toBe(api.getLocalTtsModelFileUrl(file).replace('https://huggingface.co/', 'https://hf-mirror.net/'));
   const alias = await model.match(api.getLocalTtsModelLoaderUrl(file));
   expect(await alias!.text()).toBe('other-revision');
   expect(alias!.headers.get('X-FluentRead-Model-Source')).toBe('https://fixture.invalid/old');
  }
  expect(fixture.puts).toEqual([]); expect(fetchPort).not.toHaveBeenCalled();
  await expect(api.isLocalTtsModelCached()).resolves.toBe(true);
 });
 it('coalesces bounded downloads and preserves all cache bytes without explicit buffer copies', async () => {
  const fixture = cacheFixture(); const api = await import('@/src/features/local-tts/offscreen/modelCache');
  const bytes = new Uint8Array(4096); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const fetchPort = vi.fn(async () => new Response(bytes, {headers: {'Content-Type': 'application/octet-stream'}})); vi.stubGlobal('fetch', fetchPort);
  const copying = vi.spyOn(ArrayBuffer.prototype, 'slice');
  const begin = performance.now();
  const first = api.cacheLocalTtsModelFiles(); const second = api.cacheLocalTtsModelFiles(); expect(first).toBe(second);
  await first;
  const sliceArgs = copying.mock.calls.map(args => [...args]);
  const explicitCopies = sliceArgs.filter(args => args.length === 1 && args[0] === 0).length; copying.mockRestore();
  expect(fetchPort).toHaveBeenCalledTimes(8); expect(fixture.puts).toHaveLength(8);
  const hashes: string[] = [];
  for (const entries of fixture.maps.values()) for (const response of entries.values()) hashes.push(createHash('sha256').update(new Uint8Array(await response.clone().arrayBuffer())).digest('hex'));
  const hash = createHash('sha256').update(bytes).digest('hex'); expect(hashes).toEqual(Array(8).fill(hash));
  if (evidence) writeFileSync(evidence + '/' + (process.env.AUDIT48D_MODE || 'current') + '-cache-performance.json', JSON.stringify({inputBytes:bytes.length,fetches:8,puts:8,explicitCopies,sliceArgs,hashes,elapsedMs:performance.now()-begin}));
  expect(explicitCopies).toBe(0);
 });
 it('rejects removal while a model download is in flight and releases the download on completion', async () => {
  const fixture = cacheFixture(); const api = await import('@/src/features/local-tts/offscreen/modelCache');
  const first = deferred<Response>(); let count = 0;
  vi.stubGlobal('fetch', vi.fn(() => ++count === 1 ? first.promise : Promise.resolve(new Response('model'))));
  const downloading = api.cacheLocalTtsModelFiles(); await flush();
  const removing = api.removeLocalTtsModelFiles().then(() => 'removed', e => (e as Error).message);
  await flush(); first.resolve(new Response('model')); await downloading;
  expect(await removing).toContain('下载');
  await api.removeLocalTtsModelFiles(); await expect(api.isLocalTtsModelCached()).resolves.toBe(false);
  expect(fixture.maps.get(LOCAL_TTS_MODEL_CACHE_NAME)!.size).toBe(0);
 });
});

describe('audit48D TTS owner public lifecycle', () => {
 it('dispose immediately cancels active and queued synthesis without recreating a worker', async () => {
  vi.useFakeTimers(); const {api} = await owner();
  const results: unknown[] = [];
  const a = api.synthesizeLocalTts('first', 'en', 'auto').catch(e => {results.push(e.name);});
  const b = api.synthesizeLocalTts('queued', 'en', 'auto').catch(e => {results.push(e.name);});
  await flush(); expect(WorkerPort.instances).toHaveLength(1);
  api.disposeLocalTtsWorker(); await flush();
  const observed = {results:[...results],workers:WorkerPort.instances.length,timers:vi.getTimerCount()};
  // 失败时也关闭 baseline 的真实队列，防止悬空 Promise 和计时器污染下一用例。
  await vi.runAllTimersAsync(); await Promise.all([a,b]); api.disposeLocalTtsWorker();
  expect(observed).toEqual({results:['AbortError','AbortError'],workers:1,timers:0});
 });
 it('does not create workers or read caches for a pre-aborted synthesis', async () => {
  const {api,fixture} = await owner(); const abort = new AbortController(); abort.abort(); fixture.caches.open.mockClear();
  await expect(api.synthesizeLocalTts('cancelled', 'en', 'auto', abort.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(WorkerPort.instances).toHaveLength(0); expect(fixture.caches.open).not.toHaveBeenCalled();
 });
 it('rejects model removal while synthesis is validating its cache', async () => {
  const {api,fixture} = await owner(); const hold = deferred<any>();
  const model = await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME); fixture.caches.open.mockImplementationOnce(() => hold.promise);
  const pending = api.synthesizeLocalTts('hello', 'en', 'auto').catch(e => e);
  const removal = api.removeLocalTtsModel().then(() => 'removed', e => e.message);
  await flush(); hold.resolve(model); await flush();
  const worker = WorkerPort.instances[0]; worker?.reply({success:true,audio:new ArrayBuffer(4)});
  await pending; api.disposeLocalTtsWorker();
  expect(await removal).toContain('运行');
 });
 it('disposes a worker after an unhinted synthesis error reaches idle timeout', async () => {
  vi.useFakeTimers(); vi.stubGlobal('navigator', {}); const {api} = await owner();
  const pending = api.synthesizeLocalTts('hello','en','auto').catch(e => e.message); await flush();
  const worker = WorkerPort.instances[0]; worker.reply({success:false,error:'invalid voice'});
  expect(await pending).toBe('invalid voice'); await vi.advanceTimersByTimeAsync(120_000);
  const terminated = worker.terminated; api.disposeLocalTtsWorker(); expect(terminated).toBe(true);
 });
 it('keeps one fresh CPU retry and ignores a stale worker response for its request ID', async () => {
  const {api} = await owner(); const pending = api.synthesizeLocalTts('hello','en','auto'); await flush();
  const old = WorkerPort.instances[0]; old.reply({success:false,retryWithCpu:true,error:'gpu'}); await flush();
  const fresh = WorkerPort.instances[1];
  expect(fresh.messages[0].device).toBe('wasm');
  old.onmessage!({data:{requestId:fresh.messages[0].requestId,success:false,retryWithCpu:true,error:'late'}} as MessageEvent);
  fresh.reply({success:true,audio:new Uint8Array([1,2]).buffer,backend:'wasm'});
  const result = await pending.catch(e => e.message); api.disposeLocalTtsWorker();
  expect(result).toMatchObject({backend:'wasm',contentType:'audio/wav'});
 });
});

describe('audit48D background public handlers', () => {
 async function handlers(status: () => Promise<LocalTtsStatus>, prepare = async (): Promise<LocalTtsPreparation> => ttsPreparation()) {
  const {createLocalTtsBackgroundHandlers} = await import('@/src/features/local-tts/background/handlers');
  const data: Record<string, unknown> = {};
  const offscreen = {status:vi.fn(status),prepare:vi.fn(prepare),remove:vi.fn(async () => undefined)};
  const list = createLocalTtsBackgroundHandlers({offscreen,storage:{get:async key => ({[key]:data[key]}),set:async value => {Object.assign(data,value);}}});
  return {data,offscreen,run:(type:string) => Promise.resolve(list.find(h => h.type === type)!.handle({type},undefined))};
 }
 it('refreshes a late state snapshot after removal instead of persisting old downloaded state', async () => {
  const first = deferred<LocalTtsStatus>(); let reads = 0;
  const s = await handlers(() => ++reads === 1 ? first.promise : Promise.resolve({models:[{model:LOCAL_TTS_MODEL_ID,downloaded:false}]}));
  const query = s.run('fluentReadGetLocalTtsModelState');
  await s.run('fluentReadRemoveLocalTtsModel'); first.resolve({models:[{model:LOCAL_TTS_MODEL_ID,downloaded:true}]});
  await expect(query).resolves.toMatchObject({downloaded:false});
  expect(s.data[LOCAL_TTS_MODEL_STATE_KEY]).toMatchObject({downloaded:false});
 });
 it('rejects removal while prepare is in flight and releases the guard after failure', async () => {
  const hold = deferred<LocalTtsPreparation>(); const s = await handlers(async () => ({models: []}), () => hold.promise);
  const preparation = s.run('fluentReadPrepareLocalTtsModel').catch(e => e.message);
  const remove = s.run('fluentReadRemoveLocalTtsModel').then(() => 'removed', e => e.message);
  hold.reject(new Error('download failed')); expect(await preparation).toBe('download failed');
  expect(await remove).toContain('下载');
  await expect(s.run('fluentReadRemoveLocalTtsModel')).resolves.toMatchObject({downloaded:false});
 });
});

describe('audit48D real Worker message entry', () => {
 it.each([0, NaN, 24000.5])('rejects invalid sampling rate %s instead of emitting a malformed WAV', async rate => {
  const s = await startWorker(async function* () {yield {audio:{audio:new Float32Array([0.5]),sampling_rate:rate}};});
  const result = await s.send({requestId:1,type:'synthesize',text:'hello'});
  expect(result).toMatchObject({success:false}); expect(result.error).toContain('采样率');
 });
 it('rejects mixed sampling rates without relabeling earlier chunks', async () => {
  const s = await startWorker(async function* () {for (const rate of [24000,16000]) yield {audio:{audio:new Float32Array([0.5]),sampling_rate:rate}};});
  const result = await s.send({requestId:1,type:'synthesize',text:'hello'});
  expect(result).toMatchObject({success:false}); expect(result.error).toContain('采样率');
 });
 it('encodes bounded chunks with identical PCM bytes and no final Float32Array merge', async () => {
  const chunkCount = process.env.AUDIT48D_PROBE === '1' ? 64 : 32;
  const chunkLength = process.env.AUDIT48D_PROBE === '1' ? 4096 : 512;
  const chunks = Array.from({length:chunkCount}, (_,i) => new Float32Array(Array.from({length:chunkLength}, (_,j) => ((i+j)%5-2)/2)));
  const s = await startWorker(async function* () {for (const chunk of chunks) yield {audio:{audio:chunk,sampling_rate:24000}};});
  const set = vi.spyOn(Float32Array.prototype,'set'); const begin = performance.now();
  const result = await s.send({requestId:1,type:'synthesize',text:'bounded '.repeat(process.env.AUDIT48D_PROBE === '1' ? 131072 : 256)});
  const copiedSamples = set.mock.calls.reduce((n,[chunk]) => n + chunk.length,0); set.mockRestore();
  expect(result).toMatchObject({success:true,backend:'wasm',samplingRate:24000});
  const view = new DataView(result.audio); expect(view.byteLength).toBe(44+chunkCount*chunkLength*2); expect(view.getUint32(24,true)).toBe(24000);
  const expected = [-32768,-16384,0,16384,32767];
  for (let i=0;i<chunkCount;i++) for (let j=0;j<chunkLength;j++) expect(view.getInt16(44+(i*chunkLength+j)*2,true)).toBe(expected[(i+j)%5]);
  const hash = createHash('sha256').update(new Uint8Array(result.audio)).digest('hex');
  if (evidence) writeFileSync(evidence + '/' + (process.env.AUDIT48D_MODE || 'current') + (process.env.AUDIT48D_PROBE === '1' ? '-probe-wav-performance.json' : '-wav-performance.json'),JSON.stringify({chunks:chunkCount,samples:chunkCount*chunkLength,copiedSamples,hash,elapsedMs:performance.now()-begin}));
  expect(copiedSamples).toBe(0);
 });
 it('reads the pinned cache before a conflicting main alias through the actual model fetch port', async () => {
  const fixture = cacheFixture(); const api = await seeded(fixture); const model = await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME);
  const pinned = api.getLocalTtsModelFileUrl('config.json'), main = api.getLocalTtsModelLoaderUrl('config.json');
  await model.put(main,new Response('other-revision',{headers:{'X-FluentRead-Model-Source':'https://fixture.invalid/old'}}));
  const s = await startWorker(async function* () {yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  let loaded = ''; external.fromPretrained.mockImplementation(async () => {loaded=await (await external.env.fetch(main)).text(); return {stream:async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}}},model:{dispose:vi.fn()}};});
  expect(pinned).not.toBe(main); await s.send({requestId:1,type:'prepare'});
  expect(loaded).toBe('pinned-config.json'); expect(external.env.useBrowserCache).toBe(false);
 });
});


describe('audit48D cancellation and deletion boundaries', () => {
 it('dispose between GPU failure and its catch cancels the CPU retry', async () => {
  const {api} = await owner(); const pending = api.synthesizeLocalTts('hello','en','auto').catch(e => e.name);
  await flush(); WorkerPort.instances[0].reply({success:false,retryWithCpu:true,error:'gpu'});
  api.disposeLocalTtsWorker(); await flush();
  const workers = WorkerPort.instances.length;
  // baseline 的迟到重建也必须显式终止，避免长计时器泄漏。
  WorkerPort.instances[1]?.reply({success:false,error:'late retry'});
  await pending; api.disposeLocalTtsWorker(); expect(workers).toBe(1);
 });
 it('waits for all cache deletions before releasing a failed removal', async () => {
  const fixture = cacheFixture(); const api = await seeded(fixture);
  const model = await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME); const hold = deferred<boolean>();
  let calls=0; model.delete.mockImplementation(() => ++calls === 1 ? Promise.reject(new Error('delete failed')) : calls === 2 ? hold.promise : Promise.resolve(true));
  fixture.caches.open.mockImplementation(async name => name === LOCAL_TTS_MODEL_CACHE_NAME ? model : ({delete:async () => true}) as any);
  let finished=false; const removal=api.removeLocalTtsModelFiles().catch(e => {finished=true; return e.message;});
  await flush(); const early = finished;
  hold.resolve(true); expect(await removal).toBe('delete failed'); expect(early).toBe(false);
 });
 it.each(['checking','initializing','ready'] as const)('translator cancellation from %s status does not start later work', async phase => {
  const {performChromeTranslation}=await import('@/src/app/offscreen/translation'); const abort=new AbortController();
  const translate=vi.fn(async () => 'result'), destroy=vi.fn(), create=vi.fn(async () => ({translate,destroy})), availability=vi.fn(async () => 'available');
  const result=performChromeTranslation('hello','en','zh',{Translator:{availability,create}},abort.signal,status => {if(status.phase===phase)abort.abort();});
  await expect(result).rejects.toMatchObject({name:'AbortError'}); await flush();
  expect(translate).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
  expect(availability).toHaveBeenCalledTimes(phase === 'checking' ? 0 : 1);
  expect(destroy).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
 });
 it('detector cancellation from ready status never calls detect and still destroys the model', async () => {
  const {detectChromeLanguage}=await import('@/src/app/offscreen/translation'); const abort=new AbortController();
  const detect=vi.fn(async () => [{detectedLanguage:'en',confidence:1}]),destroy=vi.fn();
  await expect(detectChromeLanguage('hello',{LanguageDetector:{create:async () => ({detect,destroy})}},abort.signal,status => {if(status.phase==='ready')abort.abort();})).rejects.toMatchObject({name:'AbortError'});
  expect(detect).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledOnce();
 });
});

describe('audit48D unchanged production adapter consumers', () => {
 it('background runtime persists state through its real lazy browser storage wiring', async () => {
  const stored:Record<string,unknown>={};
  vi.stubGlobal('browser',{storage:{local:{get:vi.fn(async key => ({[key]:stored[key]})),set:vi.fn(async value => {Object.assign(stored,value);})}}});
  vi.stubGlobal('chrome',{offscreen:{createDocument:async () => undefined},runtime:{getContexts:async () => [{}],sendMessage:(message:{type:string},callback:(response:unknown)=>void) => callback(message.type === 'FLUENT_READ_OFFSCREEN_READY' ? {success:true,ready:true} : {success:true,models:[{model:LOCAL_TTS_MODEL_ID,downloaded:true}]})}});
  const {createLocalTtsBackgroundRuntime}=await import('@/src/features/local-tts/background/runtime');
  const list=createLocalTtsBackgroundRuntime();
  await expect(list[0].handle({type:list[0].type},undefined)).resolves.toMatchObject({downloaded:true});
  expect(stored[LOCAL_TTS_MODEL_STATE_KEY]).toMatchObject({downloaded:true});
 });
 it('local translation adapter carries detection samples and routes every model action via the real offscreen client', async () => {
  const {createOffscreenClient}=await import('@/src/platform/offscreen/client');
  const {createLocalTranslationOffscreenAdapter}=await import('@/src/platform/offscreen/localTranslation');
  const messages:Array<Record<string,any>>=[]; let failure=false;
  const client=createOffscreenClient({getOffscreen:() => ({createDocument:async () => undefined}),getRuntime:() => ({getContexts:async () => [{}],sendMessage:(value,callback) => {
   const m=value as Record<string,any>; messages.push(m);
   callback(m.type === 'FLUENT_READ_OFFSCREEN_READY' ? {success:true,ready:true} : failure ? {success:false,error:'controlled failure'} : {success:true,result:'translated',model:m.model,models:[],...translationSnapshot()});
  }})});
  const adapter=createLocalTranslationOffscreenAdapter(client); const abort=new AbortController();
  await expect(adapter.translate({model:LOCAL_TRANSLATION_MODEL_IDS.m2m100,text:'markers',sourceLanguage:'auto',targetLanguage:'zh',sourceLanguageDetectionText:'clean sample'},{signal:abort.signal})).resolves.toBe('translated');
  expect(messages.find(m => m.type === 'LOCAL_TRANSLATION_TRANSLATE')).toMatchObject({target:'offscreen',sourceLanguageDetectionText:'clean sample',requestId:expect.any(String)});
  await expect(adapter.prepare(LOCAL_TRANSLATION_MODEL_IDS.m2m100,true)).resolves.toMatchObject({model:LOCAL_TRANSLATION_MODEL_IDS.m2m100});
  await expect(adapter.status()).resolves.toMatchObject({success:true});
  await expect(adapter.pause(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toMatchObject({model:LOCAL_TRANSLATION_MODEL_IDS.m2m100});
  await expect(adapter.remove(LOCAL_TRANSLATION_MODEL_IDS.m2m100)).resolves.toBeUndefined();
  failure=true;
  for (const action of [() => adapter.translate({model:LOCAL_TRANSLATION_MODEL_IDS.m2m100,text:'hello',sourceLanguage:'en',targetLanguage:'zh'}), () => adapter.prepare(LOCAL_TRANSLATION_MODEL_IDS.m2m100), () => adapter.status(), () => adapter.pause(LOCAL_TRANSLATION_MODEL_IDS.m2m100), () => adapter.remove(LOCAL_TRANSLATION_MODEL_IDS.m2m100)]) await expect(action()).rejects.toThrow('controlled failure');
 });
});


describe('audit48D retained public contracts', () => {
 it('prepares and reports cached files without inference and removes only after successful completion', async () => {
  const {api}=await owner(); vi.stubGlobal('fetch',vi.fn(async () => {throw new Error('unexpected network');}));
  await expect(api.prepareLocalTtsModel(true)).resolves.toMatchObject({model:LOCAL_TTS_MODEL_ID,warm:false});
  await expect(api.getLocalTtsModelStatus()).resolves.toMatchObject({models:[{downloaded:true}]});
  expect(WorkerPort.instances).toHaveLength(0);
  await api.removeLocalTtsModel(); await expect(api.getLocalTtsModelStatus()).resolves.toMatchObject({models:[{downloaded:false}]});
  await expect(api.synthesizeLocalTts('bonjour','fr','auto')).rejects.toMatchObject({code:'local-tts-language-unsupported'});
  await expect(api.synthesizeLocalTts('hello','en','auto')).rejects.toMatchObject({code:'local-tts-model-not-downloaded'});
  api.disposeLocalTtsWorker(); expect(WorkerPort.instances).toHaveLength(0);
 });
 it('a repeat prepare reuses canonical cache aliases without rewriting full model bodies', async () => {
  const fixture=cacheFixture(); const api=await import('@/src/features/local-tts/offscreen/modelCache');
  vi.stubGlobal('fetch',vi.fn(async () => new Response('bounded bytes'))); await api.cacheLocalTtsModelFiles();
  fixture.puts.length=0; await api.cacheLocalTtsModelFiles(); expect(fixture.puts).toEqual([]);
 });
 it('preserves nested audio fallback and snapshots reusable model buffers before the next chunk', async () => {
  const reusable=new Float32Array([0.5,-0.5]);
  const s=await startWorker(async function* () {
   yield {audio:{audio:reusable,sampling_rate:24000}};
   reusable.fill(0.25);
   yield {audio:{audio:[new Float32Array([1]),new Float32Array([-1])],sampling_rate:24000}};
  });
  const result=await s.send({requestId:1,type:'synthesize',text:'hello',voice:'zf_001',speed:2});
  expect(result).toMatchObject({success:true}); const view=new DataView(result.audio);
  expect(Array.from({length:4},(_,i) => view.getInt16(44+i*2,true))).toEqual([16384,-16384,32767,-32768]);
 });
 it('synthesis crosses the real adapter, client, router and owner then releases every cancellation resource', async () => {
  const {api}=await owner();
  const {createOffscreenMessageListener}=await import('@/src/app/offscreen/messageRouter');
  const {createOffscreenClient}=await import('@/src/platform/offscreen/client');
  const {createLocalTtsOffscreenAdapter}=await import('@/src/features/local-tts/background/offscreenAdapter');
  const listener=createOffscreenMessageListener({translate:async () => '',ttsPlayer:{play:async () => undefined,stop:() => false,seek:() => {throw Error('Unexpected speech seek in local synthesis fixture');}},fetchImage:async () => '',translateImage:async () => ({}),translateArea:async () => ({}),downloadOcrLanguages:async () => undefined,
   localTts:{synthesize:(r,signal) => api.synthesizeLocalTts(String(r.text),String(r.language),r.voice,signal),prepare:() => api.prepareLocalTtsModel(),status:api.getLocalTtsModelStatus,removeModel:api.removeLocalTtsModel}});
  const client=createOffscreenClient({getOffscreen:() => ({createDocument:async () => undefined}),getRuntime:() => ({getContexts:async () => [{}],sendMessage:(message,callback) => {expect(listener(message,{},callback)).toBe(true);}})});
  const adapter=createLocalTtsOffscreenAdapter(client);
  const pending=adapter.synthesize('hello','en','auto'); await flush();
  WorkerPort.instances[0].reply({success:true,audio:new Uint8Array([82,73,70,70]).buffer,backend:'wasm'});
  const audio=await pending; expect(new Uint8Array(audio.audio)).toEqual(new Uint8Array([82,73,70,70])); expect(audio.voice).toBe('af_maple');
  const abort=new AbortController(); const cancelled=adapter.synthesize('cancel','en','auto',abort.signal); await flush();
  const failure=expect(cancelled).rejects.toMatchObject({name:'AbortError'}); abort.abort(); await failure; await flush();
  expect(WorkerPort.instances[0].terminated).toBe(true); api.disposeLocalTtsWorker();
 });
});


describe('audit48D storage consumer during removal', () => {
 it('lets a storage-triggered state query finish with the removed model instead of a transient error', async () => {
  const {createLocalTtsBackgroundHandlers}=await import('@/src/features/local-tts/background/handlers');
  let query:Promise<unknown>|undefined; const data:Record<string,unknown>={}; let list:ReturnType<typeof createLocalTtsBackgroundHandlers>;
  list=createLocalTtsBackgroundHandlers({offscreen:{prepare:async () => ttsPreparation(),status:async () => ({models:[{model:LOCAL_TTS_MODEL_ID,downloaded:false}]}),remove:async () => undefined},storage:{get:async key => ({[key]:data[key]}),set:async value => {
   Object.assign(data,value); if (!query) query=Promise.resolve(list[0].handle({type:list[0].type},undefined));
  }}});
  await list[2].handle({type:list[2].type},undefined); await expect(query).resolves.toMatchObject({downloaded:false});
 });
});

describe('audit48D physical offscreen document lifecycle', () => {
 it('reuses a late native creation after its preparation deadline without a concurrent second create', async () => {
  vi.useFakeTimers(); const {createOffscreenClient}=await import('@/src/platform/offscreen/client');
  const hold=deferred<void>(); let present=false;
  const createDocument=vi.fn(() => hold.promise.then(() => {present=true;}));
  const client=createOffscreenClient({preparationTimeoutMs:20,getOffscreen:() => ({createDocument}),getRuntime:() => ({getContexts:async () => present?[{}]:[],sendMessage:(_message,callback) => callback({success:true,ready:true})})});
  const first=client.ensureDocument().catch(e => e.message); await flush(); expect(createDocument).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20); expect(await first).toContain('超时');
  const second=client.ensureDocument(); await flush(); const whilePending=createDocument.mock.calls.length;
  hold.resolve(); await expect(second).resolves.toBeUndefined(); expect(whilePending).toBe(1); expect(createDocument).toHaveBeenCalledOnce();
 });
});

describe('audit48D bounded background state reconciliation', () => {
 it('settles repeated legal mutations during every status read within a bounded attempt count', async () => {
  const {createLocalTtsBackgroundHandlers}=await import('@/src/features/local-tts/background/handlers');
  const marker=evidence ? evidence+'/'+(process.env.AUDIT48D_MODE || 'current')+'-state-loop-marker.json' : undefined;
  if (process.env.AUDIT48D_LOOP_PROBE === '1') {
   console.info('AUDIT48D_MODULE_LOADED:src/features/local-tts/background/handlers.ts');
   if (marker) writeFileSync(marker,JSON.stringify({moduleLoaded:true,reads:0,legalMutations:0}));
  }
  let reads=0; let downloaded=false; let list:ReturnType<typeof createLocalTtsBackgroundHandlers>;
  const stored:Record<string,unknown>={};
  const status=vi.fn(async () => {
   const stale=downloaded; reads++;
   if (process.env.AUDIT48D_LOOP_PROBE !== '1' && reads>64) throw new Error('controlled fixture attempt cap reached');
   const mutation=list[reads%2 ? 1 : 2];
   await mutation.handle({type:mutation.type},undefined);
   if(marker && process.env.AUDIT48D_LOOP_PROBE === '1' && reads<=9) writeFileSync(marker,JSON.stringify({moduleLoaded:true,reads,legalMutations:reads}));
   return {models:[{model:LOCAL_TTS_MODEL_ID,downloaded:stale}]};
  });
  list=createLocalTtsBackgroundHandlers({offscreen:{status,prepare:async () => {downloaded=true;return ttsPreparation();},remove:async () => {downloaded=false;}},storage:{get:async key => ({[key]:stored[key]}),set:async value => {Object.assign(stored,value);}}});
  await expect(list[0].handle({type:list[0].type},undefined)).rejects.toThrow('状态变更过于频繁');
  expect(reads).toBeLessThanOrEqual(8);
  expect(stored[LOCAL_TTS_MODEL_STATE_KEY]).toMatchObject({downloaded});
  if (evidence) writeFileSync(evidence+'/'+(process.env.AUDIT48D_MODE || 'current')+'-state-retry-probe.json',JSON.stringify({reads,downloaded,stored:stored[LOCAL_TTS_MODEL_STATE_KEY]}));
 });
 it('returns the latest state after two real mutations and never persists the earlier snapshots', async () => {
  const {createLocalTtsBackgroundHandlers}=await import('@/src/features/local-tts/background/handlers');
  let reads=0; let downloaded=false; let list:ReturnType<typeof createLocalTtsBackgroundHandlers>;
  const writes:boolean[]=[];
  list=createLocalTtsBackgroundHandlers({offscreen:{status:async () => {
   const stale=downloaded; reads++;
   if(reads<=2) {const h=list[reads===1 ? 1 : 2];await h.handle({type:h.type},undefined);}
   return {models:[{model:LOCAL_TTS_MODEL_ID,downloaded:stale}]};
  },prepare:async () => {downloaded=true;return ttsPreparation();},remove:async () => {downloaded=false;}},storage:{get:async () => ({}),set:async value => {writes.push((value[LOCAL_TTS_MODEL_STATE_KEY] as {downloaded:boolean}).downloaded);}}});
  await expect(list[0].handle({type:list[0].type},undefined)).resolves.toMatchObject({downloaded:false});
  expect(reads).toBe(3); expect(writes).toEqual([true,false,false]);
 });
 it('refreshes a query when a storage consumer starts a prepare during its state write', async () => {
  const {createLocalTtsBackgroundHandlers}=await import('@/src/features/local-tts/background/handlers');
  let downloaded=false; let mutation:Promise<unknown>|undefined; let list:ReturnType<typeof createLocalTtsBackgroundHandlers>;
  const writes:boolean[]=[];
  list=createLocalTtsBackgroundHandlers({offscreen:{status:async () => ({models:[{model:LOCAL_TTS_MODEL_ID,downloaded}]}),prepare:async () => {downloaded=true;return ttsPreparation();},remove:async () => undefined},storage:{get:async () => ({}),set:async value => {
   writes.push((value[LOCAL_TTS_MODEL_STATE_KEY] as {downloaded:boolean}).downloaded);
   if(!mutation) mutation=Promise.resolve(list[1].handle({type:list[1].type},undefined));
  }}});
  await expect(list[0].handle({type:list[0].type},undefined)).resolves.toMatchObject({downloaded:true});
  await mutation; expect(writes).toEqual([false,true,true]);
 });
 it('refreshes a late snapshot that began during prepare and resolves after prepare persisted completion', async () => {
  const {createLocalTtsBackgroundHandlers}=await import('@/src/features/local-tts/background/handlers');
  const prepared=deferred<LocalTtsPreparation>(),snapshot=deferred<LocalTtsStatus>();let reads=0;
  const stored:Record<string,unknown>={};
  const list=createLocalTtsBackgroundHandlers({offscreen:{prepare:() => prepared.promise,status:() => ++reads===1 ? snapshot.promise : Promise.resolve({models:[{model:LOCAL_TTS_MODEL_ID,downloaded:true}]}),remove:async () => undefined},storage:{get:async key => ({[key]:stored[key]}),set:async value => {Object.assign(stored,value);}}});
  const preparation=list[1].handle({type:list[1].type},undefined);
  const query=list[0].handle({type:list[0].type},undefined);prepared.resolve({warm: false,});await preparation;
  snapshot.resolve({models:[{model:LOCAL_TTS_MODEL_ID,downloaded:false}]});
  await expect(query).resolves.toMatchObject({downloaded:true});expect(stored[LOCAL_TTS_MODEL_STATE_KEY]).toMatchObject({downloaded:true});expect(reads).toBe(2);
 });
 it('retains the newest committed prepare when an older concurrent preparation completes late', async () => {
  const {createLocalTtsBackgroundHandlers}=await import('@/src/features/local-tts/background/handlers');
  const older=deferred<LocalTtsPreparation>(),newer=deferred<LocalTtsPreparation>();const stored:Record<string,unknown>={};let calls=0;
  const list=createLocalTtsBackgroundHandlers({offscreen:{prepare:() => ++calls===1 ? older.promise : newer.promise,status:async () => ({models: []}),remove:async () => undefined},storage:{get:async key => ({[key]:stored[key]}),set:async value => {Object.assign(stored,value);}}});
  const a=list[1].handle({type:list[1].type},undefined),b=list[1].handle({type:list[1].type},undefined);
  newer.resolve({warm: false,revision:'newer'});await b;older.resolve({warm: false,revision:'older'});await a;
  await expect(list[0].handle({type:list[0].type},undefined)).resolves.toMatchObject({downloaded:true,models:[{revision:'newer'}]});
  expect(stored[LOCAL_TTS_MODEL_STATE_KEY]).toMatchObject({revision:'newer'});
 });
});

describe('audit48D remaining public offscreen branches', () => {
 it('destroys a translator that resolves after create synchronously aborts its caller', async () => {
  const {performChromeTranslation}=await import('@/src/app/offscreen/translation');
  const abort=new AbortController(),destroy=vi.fn(),translate=vi.fn(async () => 'late');
  await expect(performChromeTranslation('hello','en','zh',{Translator:{create:() => {abort.abort();return Promise.resolve({destroy,translate});}}},abort.signal)).rejects.toMatchObject({name:'AbortError'});
  await flush(); expect(destroy).toHaveBeenCalledOnce(); expect(translate).not.toHaveBeenCalled();
 });
 it('retries native creation after a late rejection while another caller is waiting on that mutation', async () => {
  vi.useFakeTimers(); const {createOffscreenClient}=await import('@/src/platform/offscreen/client');
  const hold=deferred<void>(); let calls=0;
  const createDocument=vi.fn(() => ++calls===1 ? hold.promise : Promise.resolve());
  const client=createOffscreenClient({preparationTimeoutMs:20,getOffscreen:() => ({createDocument}),getRuntime:() => ({getContexts:async () => [],sendMessage:(_m,callback) => callback({success:true,ready:true})})});
  const first=client.ensureDocument().catch(e => e.message); await flush(); await vi.advanceTimersByTimeAsync(20); expect(await first).toContain('超时');
  const second=client.ensureDocument(); await flush(); expect(createDocument).toHaveBeenCalledOnce();
  hold.reject(new Error('late native failure')); await expect(second).resolves.toBeUndefined(); expect(createDocument).toHaveBeenCalledTimes(2);
 });
 it('uses each local translation fallback error for empty or absent external responses', async () => {
  const {createOffscreenClient}=await import('@/src/platform/offscreen/client');
  const {createLocalTranslationOffscreenAdapter}=await import('@/src/platform/offscreen/localTranslation');
  let response:unknown=undefined;
  const client=createOffscreenClient({getOffscreen:() => ({createDocument:async () => undefined}),getRuntime:() => ({getContexts:async () => [{}],sendMessage:(m,callback) => callback((m as {type:string}).type==='FLUENT_READ_OFFSCREEN_READY' ? {success:true,ready:true} : response)})});
  const adapter=createLocalTranslationOffscreenAdapter(client);
  const actions=[{run:() => adapter.translate({model:LOCAL_TRANSLATION_MODEL_IDS.m2m100,text:'hello',sourceLanguage:'en',targetLanguage:'zh'}),error:'本地翻译失败'},{run:() => adapter.prepare(LOCAL_TRANSLATION_MODEL_IDS.m2m100),error:'本地翻译模型下载失败'},{run:() => adapter.status(),error:'无法读取本地翻译模型状态'},{run:() => adapter.pause(LOCAL_TRANSLATION_MODEL_IDS.m2m100),error:'LOCAL_TRANSLATION_PAUSE_FAILED'},{run:() => adapter.remove(LOCAL_TRANSLATION_MODEL_IDS.m2m100),error:'本地翻译模型清除失败'}];
  for(response of [undefined,{success:false,error:''},{success:false,error:42}]) for(const action of actions) await expect(action.run()).rejects.toThrow(response && typeof response === 'object' && 'error' in response && typeof response.error === 'string' ? action.error : '响应消息格式无效');
 });
});

describe('audit48D cache external failure boundaries', () => {
 it('rejects a non-OK download response without retaining its body and then permits recovery', async () => {
  const fixture=cacheFixture();const api=await import('@/src/features/local-tts/offscreen/modelCache');
  const fetchPort=vi.fn(async (_input:RequestInfo | URL) => new Response('failed body',{status:503}));vi.stubGlobal('fetch',fetchPort);
  await expect(api.cacheLocalTtsModelFiles()).rejects.toThrow('模型文件下载失败（503）');expect(fixture.puts).toEqual([]);
  const pinned=api.getLocalTtsModelFileUrl(api.LOCAL_TTS_MODEL_FILES[0]);
  expect(fetchPort.mock.calls.map(([url]) => url)).toEqual([pinned,pinned.replace('https://huggingface.co/','https://hf-mirror.com/')]);
  fetchPort.mockImplementation(async () => new Response('recovered'));
  await api.cacheLocalTtsModelFiles();await expect(api.isLocalTtsModelCached()).resolves.toBe(true);
 });
 it('recovers download and removal after Cache Storage is unavailable', async () => {
  vi.stubGlobal('caches',undefined); const api=await import('@/src/features/local-tts/offscreen/modelCache');
  await expect(api.isLocalTtsModelCached()).resolves.toBe(false);
  await expect(api.cacheLocalTtsModelFiles()).rejects.toThrow('不支持本地 TTS 模型缓存');
  await expect(api.removeLocalTtsModelFiles()).rejects.toThrow('不支持本地 TTS 模型缓存');
  const fixture=cacheFixture(); vi.stubGlobal('fetch',vi.fn(async () => new Response('model')));
  await api.cacheLocalTtsModelFiles(); expect(fixture.puts).toHaveLength(8); await api.removeLocalTtsModelFiles();
 });
 it.each([{value:new Error('network disconnected'),message:'network disconnected'},{value:'rejected string',message:'rejected string'},{value:new Error('本地 TTS 模型文件下载失败：controlled'),message:'controlled'}])('releases download ownership after external failure $message', async ({value,message}) => {
  cacheFixture(); const api=await import('@/src/features/local-tts/offscreen/modelCache');
  const fetchPort=vi.fn().mockRejectedValue(value);vi.stubGlobal('fetch',fetchPort);
  await expect(api.cacheLocalTtsModelFiles()).rejects.toThrow(message);
  const pinned=api.getLocalTtsModelFileUrl(api.LOCAL_TTS_MODEL_FILES[0]);
  expect(fetchPort.mock.calls.map(([url]) => url)).toEqual([pinned,pinned.replace('https://huggingface.co/','https://hf-mirror.com/')]);
  fetchPort.mockImplementation(async () => new Response('retry bytes'));
  await api.cacheLocalTtsModelFiles(); await expect(api.isLocalTtsModelCached()).resolves.toBe(true);
 });
 it('aborts a stalled model download at its real timer and permits a later download', async () => {
  vi.useFakeTimers();cacheFixture(); const api=await import('@/src/features/local-tts/offscreen/modelCache');
  const fetchPort=vi.fn((_url,options) => new Promise<Response>((_resolve,reject) => {options.signal.addEventListener('abort',() => reject(new Error('port aborted')),{once:true});})); vi.stubGlobal('fetch',fetchPort);
  const pending=api.cacheLocalTtsModelFiles().catch(e => e.message);await flush();await vi.advanceTimersByTimeAsync(300000);
  expect(await pending).toBe('模型文件下载超过等待时限');expect(fetchPort).toHaveBeenCalledTimes(2);for(const [,options] of fetchPort.mock.calls) expect(options.signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
  fetchPort.mockImplementation(async () => new Response('retry'));await api.cacheLocalTtsModelFiles();
 });
 it('rejects a download and second removal while pending deletion owns the cache', async () => {
  const fixture=cacheFixture();const api=await seeded(fixture);const model=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME),voice=await fixture.caches.open(LOCAL_TTS_VOICE_CACHE_NAME);
  const hold=deferred<boolean>();model.delete.mockImplementationOnce(() => hold.promise);fixture.caches.open.mockImplementation(async name => name===LOCAL_TTS_MODEL_CACHE_NAME ? model : voice);
  const removing=api.removeLocalTtsModelFiles();await flush();await expect(api.isLocalTtsModelCached()).resolves.toBe(false);
  await expect(api.cacheLocalTtsModelFiles()).rejects.toThrow('正在清除');await expect(api.removeLocalTtsModelFiles()).rejects.toThrow('正在清除');
  hold.resolve(true);await removing;vi.stubGlobal('fetch',vi.fn(async () => new Response('retry')));await api.cacheLocalTtsModelFiles();
 });
});

describe('audit48D TTS owner external failure boundaries', () => {
 it.each([{value:new Error('clone failure'),message:'clone failure'},{value:'string clone failure',message:'string clone failure'},{value:{reason:'port'},message:'无法启动本地 TTS Worker'}])('rejects synchronous Worker post errors without leaving pending requests: $message', async ({value,message}) => {
  const {api}=await owner();vi.spyOn(WorkerPort.prototype,'postMessage').mockImplementationOnce(() => {throw value;});
  await expect(api.synthesizeLocalTts('hello','en','auto',new AbortController().signal)).rejects.toThrow(message);
  expect(WorkerPort.instances[0].terminated).toBe(true);await api.removeLocalTtsModel();api.disposeLocalTtsWorker();
 });
 it('rejects an abort during Worker construction before posting or leaving a timeout', async () => {
  vi.useFakeTimers();const {api}=await owner();const abort=new AbortController();
  vi.stubGlobal('Worker',class extends WorkerPort {constructor(){super();abort.abort();}});
  await expect(api.synthesizeLocalTts('hello','en','auto',abort.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(WorkerPort.instances[0].messages).toEqual([]);expect(WorkerPort.instances[0].terminated).toBe(true);expect(vi.getTimerCount()).toBe(0);api.disposeLocalTtsWorker();
 });
 it('ignores malformed and unknown responses and uses runtime URLs while retaining CPU fallback defaults', async () => {
  const {api}=await owner();const getURL=vi.fn(() => 'chrome-extension://fixture/resolvedWorker.js');vi.stubGlobal('chrome',{runtime:{getURL}});
  const pending=api.synthesizeLocalTts('hello','en','auto').catch(e => e.message);await flush();const old=WorkerPort.instances[0];
  old.onmessage!({data:null} as MessageEvent);old.onmessage!({data:{requestId:-1,success:true}} as MessageEvent);
  old.reply({success:false,retryWithCpu:true});await flush();const fresh=WorkerPort.instances[1];
  old.onerror!({message:'stale worker error'} as ErrorEvent);fresh.reply({success:false});
  expect(await pending).toBe('本地 TTS Worker 失败');expect(getURL).toHaveBeenCalledTimes(2);api.disposeLocalTtsWorker();
 });
 it('uses a fresh CPU Worker after an unlabelled native error and rejects absent audio', async () => {
  const {api}=await owner();const pending=api.synthesizeLocalTts('hello','en','auto').catch(e => e.message);await flush();
  WorkerPort.instances[0].onerror!({message:''} as ErrorEvent);await flush();WorkerPort.instances[1].reply({success:true});
  expect(await pending).toBe('本地 TTS 未返回音频');expect(WorkerPort.instances[1].messages[0].device).toBe('wasm');api.disposeLocalTtsWorker();
 });
 it('does not retry a cancelled GPU failure after its response removed the abort listener', async () => {
  const {api}=await owner();const abort=new AbortController();const pending=api.synthesizeLocalTts('hello','en','auto',abort.signal).catch(e => e.name);await flush();
  WorkerPort.instances[0].reply({success:false,retryWithCpu:true,error:'gpu'});abort.abort();
  expect(await pending).toBe('AbortError');expect(WorkerPort.instances).toHaveLength(1);api.disposeLocalTtsWorker();
 });
 it('rejects an audio response cancelled before the public synthesis promise settles', async () => {
  const {api}=await owner();const abort=new AbortController();const pending=api.synthesizeLocalTts('hello','en','auto',abort.signal).catch(e => e.name);await flush();
  WorkerPort.instances[0].reply({success:true,audio:new ArrayBuffer(4)});abort.abort();expect(await pending).toBe('AbortError');api.disposeLocalTtsWorker();
 });
 it('does not rebuild CPU after the overall synthesis budget has elapsed', async () => {
  vi.useFakeTimers();const {api}=await owner();const pending=api.synthesizeLocalTts('hello','en','auto').catch(e => e.message);await flush();
  vi.setSystemTime(Date.now()+120001);WorkerPort.instances[0].onerror!({message:'expired native worker'} as ErrorEvent);
  expect(await pending).toBe('expired native worker');expect(WorkerPort.instances).toHaveLength(1);api.disposeLocalTtsWorker();expect(vi.getTimerCount()).toBe(0);
 });
 it('cancels synthesis after disposal during cache validation and after abort while queued', async () => {
  const {api,fixture}=await owner();const model=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME),hold=deferred<any>();fixture.caches.open.mockImplementationOnce(() => hold.promise);
  const checking=api.synthesizeLocalTts('checking','en','auto').catch(e => e.name);api.disposeLocalTtsWorker();hold.resolve(model);await flush();
  const createdDuringCheck=WorkerPort.instances.length;WorkerPort.instances[0]?.reply({success:true,audio:new ArrayBuffer(4)});const checkingResult=await checking;api.disposeLocalTtsWorker();WorkerPort.instances=[];
  const first=api.synthesizeLocalTts('first','en','auto');const abort=new AbortController();const queued=api.synthesizeLocalTts('queued','en','auto',abort.signal).catch(e => e.name);await flush();abort.abort();
  WorkerPort.instances[0].reply({success:true,audio:new ArrayBuffer(4)});await first;const queuedResult=await queued;const messages=WorkerPort.instances[0].messages.length;api.disposeLocalTtsWorker();
  expect(checkingResult).toBe('AbortError');expect(createdDuringCheck).toBe(0);expect(queuedResult).toBe('AbortError');expect(messages).toBe(1);
 });
 it('prevents prepare synthesis and duplicate removal while the owner deletes model files', async () => {
  const {api,fixture}=await owner();const model=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME),voice=await fixture.caches.open(LOCAL_TTS_VOICE_CACHE_NAME);const hold=deferred<boolean>();
  model.delete.mockImplementationOnce(() => hold.promise);fixture.caches.open.mockImplementation(async name => name===LOCAL_TTS_MODEL_CACHE_NAME ? model : voice);
  const removing=api.removeLocalTtsModel();await flush();
  const preparation=await api.prepareLocalTtsModel().then(() => 'prepared',e => e.message);
  const synthesis=await api.synthesizeLocalTts('hello','en','auto').then(() => 'synthesized',e => e.message);
  const duplicate=await api.removeLocalTtsModel().then(() => 'removed',e => e.message);
  hold.resolve(true);await removing;api.disposeLocalTtsWorker();
  for(const result of [preparation,synthesis,duplicate]) expect(result).toContain('正在清除');
 });
 it('blocks removal during preparation and detects a cache port that failed to retain downloaded files', async () => {
  const fixture=cacheFixture();vi.stubGlobal('window',{setTimeout,clearTimeout,location:{href:'chrome-extension://fixture/offscreen.html'}});const api=await import('@/src/features/local-tts/offscreen/tts');
  const model=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME),voice=await fixture.caches.open(LOCAL_TTS_VOICE_CACHE_NAME);model.put.mockResolvedValue(undefined);voice.put.mockResolvedValue(undefined);fixture.caches.open.mockImplementation(async name => name===LOCAL_TTS_MODEL_CACHE_NAME ? model : voice);
  const hold=deferred<Response>();vi.stubGlobal('fetch',vi.fn().mockImplementationOnce(() => hold.promise).mockImplementation(async () => new Response('lost files')));
  const prepare=api.prepareLocalTtsModel().catch(e => e.message);await flush();const removal=await api.removeLocalTtsModel().then(() => 'removed',e => e.message);
  hold.resolve(new Response('lost'));const prepared=await prepare;await api.removeLocalTtsModel();api.disposeLocalTtsWorker();expect(removal).toContain('正在下载');expect(prepared).toBe('本地 TTS 模型缓存不完整');
 });
});

describe('audit48D Worker controlled model ports', () => {
 it('uses real WASM setup with a controlled packaged fetch and releases its temporary binary', async () => {
  const fetchPort=vi.fn(async (_input:RequestInfo | URL) => new Response(new Uint8Array([0,97,115,109,1,0,0,0])));vi.stubGlobal('fetch',fetchPort);
  external.env.backends.onnx.wasm={};const getURL=vi.fn(path => 'chrome-extension://fixture/'+path);vi.stubGlobal('chrome',{runtime:{getURL}});
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  await expect(s.send({requestId:1,type:'prepare'})).resolves.toMatchObject({success:true,backend:'wasm'});
  expect(fetchPort).toHaveBeenCalledOnce();expect(fetchPort.mock.calls[0][0]).toBe('chrome-extension://fixture/fluent-read-ai/ort-wasm-simd-threaded.jspi.wasm');
  expect(external.env.backends.onnx.wasm).toMatchObject({numThreads:1,proxy:false,wasmBinary:undefined,wasmPaths:{mjs:'chrome-extension://fixture/fluent-read-ai/ort-wasm-simd-threaded.jspi.mjs',wasm:'chrome-extension://fixture/fluent-read-ai/ort-wasm-simd-threaded.jspi.wasm'}});
  await s.send({requestId:2,type:'dispose'});
 });
 it('reads fixed model and voice caches for string URL and Request inputs and forwards only packaged requests', async () => {
  const fixture=cacheFixture(),api=await seeded(fixture);const model=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME);
  const file='config.json',pinned=api.getLocalTtsModelFileUrl(file),main=api.getLocalTtsModelLoaderUrl(file),voice=api.getLocalTtsVoiceCacheUrl('zf_001');
  await model.delete(pinned);await model.put(main,new Response('owned alias',{headers:{'X-FluentRead-Model-Source':pinned}}));
  const native=vi.fn(async () => new Response('packaged asset'));vi.stubGlobal('fetch',native);
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  const read:string[]=[];
  external.fromPretrained.mockImplementation(async () => {
   for(const input of [main,new URL(pinned),new Request(main),voice,'chrome-extension://fixture/runtime.mjs']) read.push(await (await external.env.fetch(input)).text());
   return {stream:async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}}},model:{}};
  });
  await expect(s.send({requestId:1,type:'prepare'})).resolves.toMatchObject({success:true});
  expect(read).toEqual(['owned alias','owned alias','owned alias','voice','packaged asset']);expect(native).toHaveBeenCalledOnce();
  await expect(s.send({requestId:2,type:'dispose'})).resolves.toMatchObject({success:true});
 });
 it('rejects missing Cache Storage and retries prepare when the external port becomes available', async () => {
  vi.stubGlobal('caches',undefined);const native=vi.fn(async () => {throw new Error('model network forbidden');});vi.stubGlobal('fetch',native);
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  const modelUrl='https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/main/config.json';
  external.fromPretrained.mockImplementation(async () => {await external.env.fetch(modelUrl);return {stream:async function*(){},model:{}};});
  await expect(s.send({requestId:1,type:'prepare'})).resolves.toMatchObject({success:false,error:'本地 TTS 缓存不可用'});expect(native).not.toHaveBeenCalled();
  const fixture=cacheFixture();await seeded(fixture);vi.stubGlobal('self',s.scope);
  await expect(s.send({requestId:2,type:'prepare'})).resolves.toMatchObject({success:true,backend:'wasm'});expect(native).not.toHaveBeenCalled();
 });
 it('refuses failed or wrong-owner model cache responses without sending a model request to native fetch', async () => {
  const fixture=cacheFixture(),api=await seeded(fixture,{status:503});const model=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME),main=api.getLocalTtsModelLoaderUrl('config.json');
  await model.put(main,new Response('unowned alias'));const native=vi.fn(async () => {throw new Error('model network forbidden');});vi.stubGlobal('fetch',native);
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  external.fromPretrained.mockImplementation(async () => {await external.env.fetch(main);return {stream:async function*(){},model:{}};});
  const result=await s.send({requestId:1,type:'prepare'});expect(result).toMatchObject({success:false});expect(result.error).toContain('缓存缺少模型文件');expect(native).not.toHaveBeenCalled();
 });
 it('preserves an explicit pinned source marker while reading a non-alias repository URL', async () => {
  const fixture=cacheFixture();const cache=await fixture.caches.open(LOCAL_TTS_MODEL_CACHE_NAME);
  const url='https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/custom/config.json';
  await cache.put(url,new Response('local-only explicit URL',{headers:{'X-FluentRead-Model-Source':url}}));
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});let body='';
  external.fromPretrained.mockImplementation(async () => {body=await (await external.env.fetch(url)).text();return {stream:async function*(){},model:{}};});
  await expect(s.send({requestId:1,type:'prepare'})).resolves.toMatchObject({success:true});expect(body).toBe('local-only explicit URL');
 });
 it('uses CPU defaults and rejects empty requests and empty model output without breaking the message queue', async () => {
  const s=await startWorker(async function*(){});
  await expect(s.send({requestId:1,type:'synthesize'})).resolves.toMatchObject({success:false,error:'本地 TTS 文本为空'});
  for(const [index,speed] of [Infinity,NaN].entries()) await expect(s.send({requestId:10+index,type:'synthesize',text:'hello',speed,voice:'  '})).resolves.toMatchObject({success:false,error:expect.stringContaining('消息格式无效')});
  await expect(s.send({requestId:2,type:'synthesize',text:'hello',voice:'  '})).resolves.toMatchObject({success:false,error:'本地 TTS 生成了静音音频'});
  const stream=vi.fn(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});external.fromPretrained.mockResolvedValue({stream,model:{}});
  await s.send({requestId:3,type:'dispose'});
  await expect(s.send({requestId:4,type:'synthesize',text:' hi ',voice:' '})).resolves.toMatchObject({success:true,backend:'wasm'});
  expect(stream).toHaveBeenCalledWith('hi',{voice:'zf_001',speed:1,maxChunkLength:180});
 });
 it('keeps disposal idempotent when no model exists or its dispose port fails', async () => {
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  await expect(s.send({requestId:1,type:'dispose'})).resolves.toMatchObject({success:true});
  const dispose=vi.fn(async () => {throw new Error('dispose driver failure');});external.fromPretrained.mockResolvedValue({stream:async function*(){},model:{dispose}});
  await s.send({requestId:2,type:'prepare'});await expect(s.send({requestId:3,type:'dispose'})).resolves.toMatchObject({success:true});expect(dispose).toHaveBeenCalledOnce();
  await expect(s.send({requestId:4,type:'dispose'})).resolves.toMatchObject({success:true});
 });
 it('ignores uncorrelated messages and rejects a malformed known request without loading a model or breaking disposal', async () => {
  const s=await startWorker(async function*(){});
  for(const value of [null,{}, {requestId:'1',type:'prepare'}]) s.scope.onmessage!({data:value} as MessageEvent);
  await flush();expect(external.fromPretrained).not.toHaveBeenCalled();expect(s.scope.postMessage).not.toHaveBeenCalled();
  await expect(s.send({requestId:1,type:'unknown'})).resolves.toMatchObject({requestId:1,success:false,error:expect.stringContaining('消息格式无效')});
  expect(external.fromPretrained).not.toHaveBeenCalled();
  await expect(s.send({requestId:2,type:'dispose'})).resolves.toMatchObject({success:true});
 });
 it('wraps a non-Error GPU initialization rejection and locks the same worker to CPU after the failure', async () => {
  const s=await startWorker(async function*(){yield {audio:{audio:new Float32Array([0.5]),sampling_rate:24000}};});
  vi.stubGlobal('navigator',{gpu:{requestAdapter:vi.fn(async () => ({info:{vendor:'controlled hardware'}}))}});
  external.fromPretrained.mockRejectedValueOnce('GPU rejected string').mockResolvedValue({stream:async function*(){},model:{}});
  await expect(s.send({requestId:1,type:'prepare'})).resolves.toMatchObject({success:false,error:'GPU rejected string',retryWithCpu:true});
  await expect(s.send({requestId:2,type:'prepare'})).resolves.toMatchObject({success:true,backend:'wasm'});
  expect(external.fromPretrained.mock.calls.map(([,options]) => options.device)).toEqual(['webgpu','wasm']);
 });
});

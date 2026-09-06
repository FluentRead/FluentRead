/**
 * @file tests/modelCacheRemoval.test.ts
 * 文件职责：验证清除本地模型确实删除目标文件且保留其他资源，并允许重新下载。
 * 主要内容：覆盖 OCR IndexedDB 精确删除、Whisper 多量化缓存清理、后台状态提交与使用中拒绝。
 * 模块边界：使用真实内存 IndexedDB 和缓存端口，不联网下载模型。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {removeOcrModelFiles} from '@/src/features/image-translation/services/ocrModelCache';
import {removeVideoAiModelFiles, cacheVideoAiQ4ModelFiles, getVideoAiModelFileUrl, VIDEO_AI_Q4_MODEL_FILES} from '@/src/features/video-subtitle/offscreen/modelCache';
import {createVideoSubtitleBackgroundHandlers} from '@/src/features/video-subtitle/background/handlers';
import {createImageOcrLanguageRepository} from '@/src/features/image-translation/background/ocrLanguageRepository';

afterEach(() => vi.unstubAllGlobals());
describe('model removal', () => {
 it('removes only selected OCR traineddata and can store it again', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  await removeOcrModelFiles(['eng']);
  const database = await new Promise<IDBDatabase>((resolve,reject) => {const r=indexedDB.open('keyval-store');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const write = () => new Promise<void>((resolve,reject) => {const tx=database.transaction('keyval','readwrite');tx.objectStore('keyval').put(new Uint8Array([1,2,3]),'fluent-read-image-ocr/eng.traineddata');tx.objectStore('keyval').put('retain','fluent-read-image-ocr/jpn.traineddata');tx.objectStore('keyval').put('other','unrelated');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
  const keys = () => new Promise<IDBValidKey[]>(resolve => {const r=database.transaction('keyval').objectStore('keyval').getAllKeys();r.onsuccess=()=>resolve(r.result);});
  await write(); await removeOcrModelFiles(['eng']);
  expect(await keys()).toEqual(['fluent-read-image-ocr/jpn.traineddata','unrelated']);
  await write(); expect(await keys()).toContain('fluent-read-image-ocr/eng.traineddata'); database.close();
 });
 it('removes q4 and q8 files for one Whisper model and downloads missing files again', async () => {
  const entries=new Map<string,Response>([[getVideoAiModelFileUrl('tiny','onnx/encoder_model_q4.onnx'),new Response('q4')],[getVideoAiModelFileUrl('tiny','onnx/encoder_model_quantized.onnx'),new Response('q8')],[getVideoAiModelFileUrl('base','config.json'),new Response('base')],['https://example.com/unrelated',new Response('other')]]);
  const cache={keys:async()=>[...entries.keys()].map(url=>new Request(url)),delete:async(request:Request)=>entries.delete(request.url),match:async(url:string)=>entries.get(url),put:async(url:string,response:Response)=>{entries.set(url,response);}};
  vi.stubGlobal('caches',{open:async()=>cache}); vi.stubGlobal('window',{setTimeout,clearTimeout});vi.stubGlobal('fetch',vi.fn(async()=>new Response('downloaded')));
  await expect(removeVideoAiModelFiles('unknown')).rejects.toThrow('无效');
  await removeVideoAiModelFiles('tiny'); expect(entries.size).toBe(2);
  expect(entries.has(getVideoAiModelFileUrl('base','config.json'))).toBe(true);
  await cacheVideoAiQ4ModelFiles('tiny'); expect(fetch).toHaveBeenCalledTimes(VIDEO_AI_Q4_MODEL_FILES.length);
 });
 it('serializes OCR state removal with later download receipts', async () => {
  let values:any={fluentReadImageOcrLanguages:['eng','jpn']};
  const repository=createImageOcrLanguageRepository({get:async()=>values,set:async next=>{values=next;}});
  await Promise.all([repository.markRemoved(['eng']),repository.markDownloaded(['spa'])]);
  expect(await repository.getDownloaded()).toEqual(['jpn','spa']);
  await repository.markDownloaded(['eng']);expect(await repository.getDownloaded()).toContain('eng');
 });
 it('updates video state only after cache deletion and rejects concurrent model use', async () => {
  let release!:()=>void;let values:any={fluentReadVideoLocalTranscriptionModels:['tiny','base']};
  const send=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {success:true};});
  const handlers=createVideoSubtitleBackgroundHandlers({offscreen:{send} as any,storage:{get:async()=>values,set:async next=>{values=next;}}});
  const call=(type:string,extra:any={})=>handlers.find(h=>h.type===type)!.handle({type,...extra},{});
  await expect(call('fluentReadRemoveLocalVideoModel',{model:'bad'})).rejects.toThrow('无效');
  const removing=call('fluentReadRemoveLocalVideoModel',{model:'tiny'});await Promise.resolve();await Promise.resolve();
  expect(values.fluentReadVideoLocalTranscriptionModels).toEqual(['tiny','base']);
  await expect(call('fluentReadRemoveLocalVideoModel',{model:'base'})).rejects.toThrow('正在');
  await expect(call('fluentReadPrepareLocalVideoModel',{model:'base'})).rejects.toThrow('清除');
  release();await expect(removing).resolves.toEqual({success:true,models:['base']});
  send.mockImplementation(async()=>({success:false}));
  await expect(call('fluentReadRemoveLocalVideoModel',{model:'base'})).rejects.toThrow('清除失败');
  expect(values.fluentReadVideoLocalTranscriptionModels).toEqual(['base']);
 });
});

it('OCR 缓存缺失和存储错误不会误报成功', async () => {
 for (const scenario of ['open-error','no-store','abort-error','abort-empty']) {
  const failure=new Error('storage'); const tx:any={objectStore:()=>({delete:()=>{}}),error:scenario==='abort-error'?failure:null};
  const close=vi.fn(); const request:any={error:failure,result:{objectStoreNames:{contains:()=>scenario!=='no-store'},close,transaction:()=>{queueMicrotask(()=>tx.onabort());return tx;}}};
  vi.stubGlobal('indexedDB',{open:()=>{queueMicrotask(()=>scenario==='open-error'?request.onerror():request.onsuccess());return request;}});
  if(scenario==='no-store') await expect(removeOcrModelFiles([])).resolves.toBeUndefined();
  else await expect(removeOcrModelFiles(['eng'])).rejects.toThrow(scenario==='abort-empty'?'语言包清除失败':'storage');
  if(scenario!=='open-error') expect(close).toHaveBeenCalledOnce();
 }
});

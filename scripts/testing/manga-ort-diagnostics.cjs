'use strict';
/**
 * @file scripts/testing/manga-ort-diagnostics.cjs
 * 文件职责：复用已审公开 ORT 创建旁观协议，严格核对固定 det/rec 与显式可选 CTD 资产身份。
 * 主要内容：缓存预载共用模型目录；按 OCR/seg 本次加载组绑定真实 loader buffer；完整保留原 Promise、原始 console 和 pre-start CDP 归属，逐序验证创建结果。
 * 模块边界：仅测试诊断，不创建会话、不调用模型、不下载、不修改 guard/日志级别/图优化/provider；det/rec 必需，seg 未懒加载不构成缺失，未知创建仍失败。
 */
const {readImageTranslationModelManifest}=require('./image-model-cache.cjs');
function getMangaOrtModelCatalog({includeSeg=false,metadataFile}={}){
 const kinds={detection:'det',recognition:'rec',segmentation:'seg'};
 return readImageTranslationModelManifest(metadataFile,{includeSeg}).filter(asset=>kinds[asset.key]).map(asset=>({key:asset.key,kind:kinds[asset.key],bytes:asset.bytes,sha256:asset.sha256,optional:asset.kind==='seg'}));
}
function normalizeModelCatalog(catalog){
 if(!Array.isArray(catalog))throw Error('Pinned model catalog required');
 const known=new Map(),keys={det:'detection',rec:'recognition',seg:'segmentation'};
 for(const model of catalog){
  if(!model||model.key!==keys[model.kind]||!keys[model.kind]||known.has(model.kind)||!Number.isSafeInteger(model.bytes)||model.bytes<=0||!/^[a-f0-9]{64}$/.test(model.sha256)||model.optional!==(model.kind==='seg'))throw Error('Invalid pinned model catalog');
  if(model.kind==='seg'&&(model.bytes!==94669756||model.sha256!=='1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f'))throw Error('Invalid pinned CTD identity');
  known.set(model.kind,model);
 }
 if(!known.has('det')||!known.has('rec'))throw Error('Required det/rec catalog missing');
 return known;
}
function validateMangaOrtModelFiles(files,modelCatalog){
 const known=normalizeModelCatalog(modelCatalog);
 for(const model of known.values()){
  const file=files.find(file=>file.key===model.key);
  if(!file||file.bytes!==model.bytes||file.sha256!==model.sha256)throw Error('Preloaded model identity mismatch: '+model.kind);
 }
 return modelCatalog;
}
function createMangaOrtDecorator({diagnosticId,expectedWorkerUrl,modelCatalog=getMangaOrtModelCatalog(),maxCreates=8}={}){
 const known=normalizeModelCatalog(modelCatalog);
 if(!/^[A-Za-z0-9_]{1,64}$/.test(diagnosticId)||typeof expectedWorkerUrl!=='string'||!expectedWorkerUrl.startsWith('chrome-extension://')||!Number.isSafeInteger(maxCreates)||maxCreates<1||maxCreates>8)throw Error('Invalid bounded creation diagnostic configuration');
 const config={diagnosticId,expectedWorkerUrl,maxCreates,models:[...known.values()].map(model=>[model.key,model.kind,model.bytes,model.sha256])};
 return '('+installMangaOrtCreateObserver.toString()+')('+JSON.stringify(config)+');';
}
function installMangaOrtCreateObserver(config){
 const marker='__FR_ORT_LOGID__',states=new WeakMap();let sequence=0;
 function emit(type,detail={}){try{console.debug(marker,JSON.stringify({diagnosticId:config.diagnosticId,sequence:++sequence,type,...detail}));}catch(_){/* Collector requires complete marker sequence/outcomes; native behavior must remain unchanged. */}}
 function incomplete(reason,detail={}){emit('incomplete',{reason,...detail});}
 function errorText(error){try{return String(error?.message??error);}catch(_){return '[unprintable original error]';}}
 function bind(state,assets,bindingGroup){
  const selected=config.models.filter(([,kind])=>(kind==='seg'?'seg':'ocr')===bindingGroup);
  if(!selected.length){incomplete('unconfigured-binding-group',{bindingGroup});return;}
  for(const [key,kind,bytes,sha256]of selected){
   const buffer=assets?.[key];
   if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==bytes){incomplete('asset-binding-mismatch',{kind,bytes:buffer?.byteLength??null});continue;}
   state.models.set(buffer,{kind,bytes,sha256});
   emit('asset-bound',{kind,bytes,sha256,bindingGroup,identityBasis:'same loader-owned ArrayBuffer; pinned source/production-derived recipe validated separately; SDK full Uint8Array view'});
  }
 }
 function decorate(original,state){
  return function(...args){
   const ordinal=++state.calls,model=args[0],options=args[1];
   if(ordinal>config.maxCreates){if(ordinal===config.maxCreates+1)incomplete('create-cap',{ordinal});return Reflect.apply(original,this,args);}
   const buffer=model instanceof ArrayBuffer?model:ArrayBuffer.isView(model)&&model.byteOffset===0&&model.byteLength===model.buffer.byteLength?model.buffer:undefined;
   const bound=buffer?state.models.get(buffer):undefined;
   let safeOptions=false;
   if(options&&typeof options==='object'&&!Array.isArray(options)){
    const proto=Object.getPrototypeOf(options),descriptors=Object.getOwnPropertyDescriptors(options);
    safeOptions=(proto===Object.prototype||proto===null)&&Object.getOwnPropertySymbols(options).length===0&&Object.values(descriptors).every(d=>d.enumerable&&'value'in d);
   }
   const known=!!bound&&model.byteLength===bound.bytes&&args.length===2&&safeOptions;
   const kind=known?bound.kind:'unknown',logId=known?'FRORT_'+config.diagnosticId+'_'+kind+'_'+ordinal:null;
   if(!known)incomplete('unknown-model-or-create-signature',{ordinal,bytes:model?.byteLength??null,bound:!!bound,args:args.length,safeOptions});
   const detail={ordinal,kind,bytes:model?.byteLength??null,logId,...(known?{sha256:bound.sha256,executionProviders:options.executionProviders,graphOptimizationLevel:options.graphOptimizationLevel}:{})};
   const actual=known?[model,{...options,logId}]:args;
   emit('create-start',detail);
   let result;
   try{result=Reflect.apply(original,this,actual);}catch(error){emit('create-error',{...detail,synchronous:true,message:errorText(error)});throw error;}
   // Return the native Promise itself; observation creates no extra native create or run.
   if(result instanceof Promise){
    try{Promise.prototype.then.call(result,()=>emit('create-ok',detail),error=>emit('create-error',{...detail,synchronous:false,message:errorText(error)}));}
    catch(error){incomplete('promise-observer-failed',{ordinal,message:errorText(error)});}
   }else incomplete('non-native-promise-result',{ordinal});
   return result;
  };
 }
 if(globalThis.__frOrtLogIdInstall){incomplete('duplicate-installer');return;}
 globalThis.__frOrtLogIdInstall=(ort,assets,bindingGroup='ocr')=>{
  if(!['ocr','seg'].includes(bindingGroup)){incomplete('unknown-binding-group');return;}
  if(globalThis.location?.href!==config.expectedWorkerUrl){incomplete('worker-url-mismatch');return;}
  const owner=ort?.InferenceSession;
  if(!owner||typeof owner.create!=='function'){incomplete('missing-public-create');return;}
  let state=states.get(owner);
  if(!state){
   const descriptor=Object.getOwnPropertyDescriptor(owner,'create');
   if(!descriptor?.writable){incomplete('create-not-writable');return;}
   state={calls:0,models:new WeakMap()};states.set(owner,state);
   const original=owner.create,wrapped=decorate(original,state);owner.create=wrapped;
   if(owner.create!==wrapped){incomplete('create-install-failed');return;}
   emit('installed',{exactWorker:true,expectedWorkerUrl:config.expectedWorkerUrl,maxCreates:config.maxCreates,publicMethod:'InferenceSession.create'});
  }
  bind(state,assets,bindingGroup);
 };
}

const fs=require('node:fs'),path=require('node:path');
const MARKER='__FR_ORT_LOGID__',MAX_RECORDS=8192,MAX_BYTES=8*1024*1024,MAX_RECORD_BYTES=65536;
const SUMMARY='creation-public-summary.json';
function analyze(records,sessions,problems,diagnosticId,modelCatalog=getMangaOrtModelCatalog()){
 const known=normalizeModelCatalog(modelCatalog);
 const issues=[...problems],targets=new Map(),issue=value=>{if(!issues.includes(value))issues.push(value);};
 for(const state of sessions.values())if(state.exact){let group=targets.get(state.targetId);if(!group){group=[];targets.set(state.targetId,group);}group.push(state);}
 const result=[];
 for(const[targetId,group]of targets){
  const candidates=group.filter(s=>s.waiting&&s.enabled&&s.resumed&&records.some(r=>r.sessionId===s.sessionId&&r.params.args?.[0]?.value===MARKER));
  const primary=candidates[0];if(!primary){issue('no-prestart-marker-session:'+targetId);continue;}
  const rows=records.filter(r=>r.sessionId===primary.sessionId),markers=[];
  for(const row of rows)if(row.params.args?.[0]?.value===MARKER){
   try{
    if(row.params.args.length!==2||row.params.args.some(a=>a.type!=='string'||typeof a.value!=='string'))throw Error('marker arguments');
    const value=JSON.parse(row.params.args[1].value);if(!value||typeof value!=='object'||value.diagnosticId!==diagnosticId)throw Error('diagnostic identity');
    if(row.prestart!==true)issue('marker-before-prestart:'+targetId);
    markers.push({...value,rowSequence:row.sequence});
   }catch(_){issue('invalid-marker:'+targetId);}
  }
  if(!markers.length||markers[0].type!=='installed'||markers.some((m,i)=>m.sequence!==i+1))issue('marker-sequence-gap:'+targetId);
  const installs=markers.filter(m=>m.type==='installed'),installed=installs[0];
  if(installs.length!==1||installed.exactWorker!==true||installed.expectedWorkerUrl!==primary.url
   ||installed.publicMethod!=='InferenceSession.create'||!Number.isSafeInteger(installed.maxCreates)||installed.maxCreates<1||installed.maxCreates>8)issue('invalid-installation:'+targetId);
  for(const m of markers){
   if(m.type==='incomplete')issue('worker-incomplete:'+targetId+':'+m.reason);
   else if(!['installed','asset-bound','create-start','create-ok','create-error'].includes(m.type))issue('unknown-marker-type:'+targetId);
  }
  const bound=new Map(),starts=markers.filter(m=>m.type==='create-start'),creates=[];
  for(const marker of markers){
   if(marker.type!=='asset-bound')continue;
   const expected=known.get(marker.kind);
   if(!expected||marker.bytes!==expected.bytes||marker.sha256!==expected.sha256
    ||(marker.bindingGroup!==undefined&&marker.bindingGroup!==(marker.kind==='seg'?'seg':'ocr')))issue('invalid-asset-binding:'+targetId);
   const previous=bound.get(marker.kind);
   if(previous&&(previous.bytes!==marker.bytes||previous.sha256!==marker.sha256))issue('asset-binding-drift:'+targetId+':'+marker.kind);
   bound.set(marker.kind,marker);
  }
  if(starts.length>(installed?.maxCreates??0))issue('create-cap:'+targetId);
  for(const[index,start]of starts.entries()){
   const expectedLogId='FRORT_'+diagnosticId+'_'+start.kind+'_'+start.ordinal;
   if(start.ordinal!==index+1)issue('create-ordinal-gap:'+targetId);
   if(!known.has(start.kind)||start.bytes!==known.get(start.kind)?.bytes||start.sha256!==known.get(start.kind)?.sha256||start.logId!==expectedLogId)issue('unknown-create:'+targetId+':'+start.ordinal);
   const binding=markers.find(m=>m.type==='asset-bound'&&m.kind===start.kind&&m.bytes===start.bytes&&m.sha256===start.sha256&&m.rowSequence<start.rowSequence);
   if(!binding)issue('unbound-create:'+targetId+':'+start.ordinal);
   const endings=markers.filter(m=>m.ordinal===start.ordinal&&['create-ok','create-error'].includes(m.type));
   const end=endings[0];
   if(endings.length!==1||!end||end.rowSequence<=start.rowSequence){issue('missing-create-outcome:'+targetId+':'+start.ordinal);}
   else if(['kind','logId','bytes','sha256'].some(key=>end[key]!==start[key]))issue('create-outcome-mismatch:'+targetId+':'+start.ordinal);
   if(end?.type==='create-error')issue('create-error:'+targetId+':'+start.ordinal);
   creates.push({ordinal:start.ordinal,kind:start.kind,logId:start.logId,bytes:start.bytes,sha256:start.sha256,
    requestedExecutionProviders:start.executionProviders,graphOptimizationLevel:start.graphOptimizationLevel,outcome:end?.type??'missing'});
  }
  for(const m of markers)if(['create-ok','create-error'].includes(m.type)&&!starts.some(s=>s.ordinal===m.ordinal))issue('orphan-create-outcome:'+targetId+':'+m.ordinal);
  for(const kind of ['det','rec',...(bound.has('seg')?['seg']:[])])if(!creates.some(c=>c.kind===kind&&c.outcome==='create-ok'))issue('missing-successful-'+kind+':'+targetId);
  result.push({targetId,primarySessionId:primary.sessionId,otherRawSessions:group.filter(s=>s!==primary).map(s=>s.sessionId),markers,creates});
 }
 if(!result.length)issue('no-exact-worker-session');
 return{mode:'creation-only',placementEvidenceNotRequested:true,complete:issues.length===0,problems:issues,targets:result,
  scope:'Only complete pre-start primary-session public model creation and raw console collection. Requested providers are configuration, not observed node placement. No node/CPU count, performance or warning-free acceptance claim.'};
}
function createOrtConsoleObserver({outputDirectory,expectedWorkerUrl,diagnosticId,WebSocketClass=globalThis.WebSocket,limits={},modelCatalog=getMangaOrtModelCatalog()}){
 normalizeModelCatalog(modelCatalog);
 if(typeof WebSocketClass!=='function')throw Error('Native WebSocket required');
 const maxRecords=limits.records??MAX_RECORDS,maxBytes=limits.bytes??MAX_BYTES,maxRecordBytes=limits.recordBytes??MAX_RECORD_BYTES;
 if(![[maxRecords,MAX_RECORDS],[maxBytes,MAX_BYTES],[maxRecordBytes,MAX_RECORD_BYTES]].every(([value,cap])=>Number.isSafeInteger(value)&&value>0&&value<=cap))throw Error('Creation observer bounds may only be reduced');
 fs.mkdirSync(outputDirectory,{recursive:true});const file=path.join(outputDirectory,'worker-console.ndjson'),fd=fs.openSync(file,'wx');
 const sessions=new Map(),pending=new Map(),problems=[];let count=0,bytes=0,dropped=0,sealed=false,writeFailed=false,final;
 function problem(value){
  if(problems.length<32&&!problems.includes(value))problems.push(value);
  if(final){final.complete=false;if(!final.problems.includes(value))final.problems.push(value);final.dropped=dropped;
   try{fs.writeFileSync(path.join(outputDirectory,SUMMARY),JSON.stringify(final,null,2)+'\n');}catch(_){}}
 }
 function incoming(message){
  if(message.id){const q=pending.get(message.id);pending.delete(message.id);if(q){const s=sessions.get(q.sessionId);if(message.error)problem('runtime-command-error:'+q.method);else if(s&&q.method==='Runtime.enable')s.enabled=true;}return;}
  const p=message.params||{};
  if(message.method==='Target.attachedToTarget'){
   const info=p.targetInfo||{},exact=info.type==='worker'&&info.url===expectedWorkerUrl;
   if(sealed&&exact)problem('post-seal-exact-worker');
   sessions.set(p.sessionId,{sessionId:p.sessionId,targetId:info.targetId,type:info.type,url:info.url,waiting:p.waitingForDebugger===true,enabled:false,resumed:false,exact});return;
  }
  if(message.method==='Target.targetInfoChanged'||message.method==='Target.targetCreated'){
   for(const s of sessions.values())if(s.targetId===p.targetInfo?.targetId){s.url=p.targetInfo.url;s.exact=s.type==='worker'&&s.url===expectedWorkerUrl;if(sealed&&s.exact)problem('post-seal-exact-worker-state');}return;
  }
  const s=sessions.get(message.sessionId);
  if(!s?.exact||message.method!=='Runtime.consoleAPICalled')return;
  if(sealed){dropped++;problem('post-seal-console');return;}
  // Snapshot readiness now; commands arriving later cannot retroactively prove pre-start capture.
  const row={sequence:count+1,at:Date.now(),sessionId:message.sessionId,targetId:s.targetId,targetType:s.type,targetUrl:s.url,prestart:s.waiting&&s.enabled&&s.resumed,params:p};
  const line=JSON.stringify(row)+'\n',length=Buffer.byteLength(line);
  if(count>=maxRecords||length>maxRecordBytes||bytes+length>maxBytes||writeFailed){dropped++;problem('console-bound-or-write-failure');return;}
  try{fs.writeSync(fd,line);count++;bytes+=length;}catch(_){writeFailed=true;dropped++;problem('console-write-failure');}
  if(p.type==='error')problem('worker-console-error');
 }
 function outgoing(message){
  if(message.method==='Runtime.enable')pending.set(message.id,{method:message.method,sessionId:message.sessionId});
  if(message.method==='Runtime.runIfWaitingForDebugger'){
   const s=sessions.get(message.sessionId);if(s){if(!s.enabled)problem('resume-before-runtime-enable');s.resumed=true;}
   pending.set(message.id,{method:message.method,sessionId:message.sessionId});
  }
 }
 class ObservedSocket extends WebSocketClass{
  constructor(...args){super(...args);this.closeRequested=false;
   this.addEventListener('message',event=>{try{incoming(JSON.parse(String(event.data)));}catch(_){problem('observer-message-parse');}});
   this.addEventListener('close',()=>{if(!this.closeRequested)problem('unexpected-cdp-close');});
   this.addEventListener('error',()=>problem('cdp-socket-error'));
  }
  send(...args){try{outgoing(JSON.parse(String(args[0])));}catch(_){problem('observer-send-parse');}return super.send(...args);}
  close(...args){this.closeRequested=true;return super.close(...args);}
 }
 return{WebSocketClass:ObservedSocket,snapshot:()=>({count,bytes,dropped,sealed,problems:[...problems]}),finish(){
  if(final)return final;sealed=true;fs.closeSync(fd);
  const records=fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  if(records.length!==count)problem('written-count-mismatch');
  for(const q of pending.values())if(sessions.get(q.sessionId)?.exact)problem('missing-runtime-command-outcome:'+q.method);
  final={...analyze(records,sessions,problems,diagnosticId,modelCatalog),rawFile:file,rawRecords:count,rawBytes:bytes,dropped,
   limits:{records:maxRecords,bytes:maxBytes,recordBytes:maxRecordBytes},observerAddsCdpCommands:false,guardWarningPolicyUnchanged:true};
  fs.writeFileSync(path.join(outputDirectory,SUMMARY),JSON.stringify(final,null,2)+'\n');return final;
 }};
}
module.exports={getMangaOrtModelCatalog,validateMangaOrtModelFiles,createMangaOrtDecorator,createOrtConsoleObserver,analyze};

'use strict';
// One serial owner: fresh A407 baseline -> same-bundle production update -> one selected XCTest -> original App restore.
// No host GUI operations, custom device sets, uninstall/reset, configuration writes or permission decisions.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{promisify}=require('node:util');
const exec=promisify(cp.execFile),root=__dirname,shared=path.dirname(root),runDirectory='inline-attempt1';
assert.equal(path.basename(root),runDirectory);assert.equal(process.argv.length,2,'Pinned final-layout owned menu-readiness/scroll singlecase only; no case override');
const plan=JSON.parse(fs.readFileSync(path.join(root,'plan.json'))),runPlan=JSON.parse(fs.readFileSync(path.join(root,'runtime-run-plan.json')));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(process.env.FLUENTREAD_PRODUCTION_RUNTIME_GO,'1','Root serial runtime GO required');
for(const [key,value] of Object.entries({FLUENTREAD_RESOURCE_LOCK_HELD:'1',FLUENTREAD_TEST_MAX_WORKERS:'1',FLUENTREAD_TEST_CONCURRENCY:'3',FLUENTREAD_TEST_CPU_TARGET:'40'}))assert.equal(process.env[key],value);
assert.equal(plan.status,'FROZEN_PRODUCTION_IDENTITY_PENDING_ROOT_SERIAL_GO');
assert.equal(plan.UDID,'A407390F-7AA8-42AE-AFEB-F93EE99E9FF8');assert.equal(plan.name,'FluentRead-PR995-FreshPermissions-20261015');assert.equal(plan.bundle,'org.example.FluentReadDevelopment');
assert.equal(runPlan.planSHA256,sha(path.join(root,'plan.json')));assert.equal(sha(plan.oldIdentity),plan.oldIdentitySHA256);assert.equal(sha(plan.newIdentity),plan.newIdentitySHA256);assert.equal(plan.artifactKind,'production');assert.equal(plan.harnessRoot,shared);assert.equal(plan.runDirectory,runDirectory);
const methods={'inline-attempt1':'testPausedMenuScrollAndClose'};assert.equal(plan.testMethod,methods[runDirectory]);
assert.notEqual(plan.newIdentitySHA256,'a13a50f6d97c6516501190ccd33a7d0241e5e06cb68eb2d9bd455ab06e97d089');assert.notEqual(plan.newWebRawSHA256,'50c33842c9595bff21eff0b9eaeb0c1bb79d08c3ef371ab3476fe304cf8b8ea2');
assert.equal(runPlan.harnessSHA256,sha(path.join(shared,'SafariSmokeTests.candidate.swift')));assert.equal(runPlan.xctestrunSHA256,sha(runPlan.xctestrunPath));assert.equal(runPlan.testMethod,methods[runDirectory]);assert.equal(runPlan.harnessSHA256,plan.harnessSourceSHA256);assert.equal(runPlan.sharedBuildReceiptSHA256,sha(path.join(shared,'build-guard-report.json')));
for(const [file,hash] of Object.entries(runPlan.sharedBinarySHA256)){assert(fs.realpathSync(file).startsWith(path.join(shared,'DerivedData/Build/Products/')));assert.equal(sha(file),hash,'Shared compiled binary changed');}
assert.equal(plan.budgetSeconds,540);assert.equal(plan.sceneBudgetSeconds,180);assert.equal(plan.runtimeProcessCeilingSeconds,240);assert.equal(plan.cleanupReserveSeconds,180);
assert(fs.realpathSync(runPlan.xctestrunPath).startsWith(path.join(shared,'DerivedData/Build/Products/')));
const exact=['xcodebuild','test-without-building','-xctestrun',runPlan.xctestrunPath,'-destination','platform=iOS Simulator,id='+plan.UDID,'-destination-timeout','15','-jobs','1','-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1','-only-testing:SafariSmokeUITests/SafariSmokeTests/'+runPlan.testMethod,'-resultBundlePath',path.join(root,'runtime.xcresult'),'CODE_SIGNING_ALLOWED=NO','CODE_SIGNING_REQUIRED=NO','DEVELOPMENT_TEAM=','CODE_SIGN_IDENTITY='];assert.deepEqual(runPlan.command,exact);
for(const name of ['runtime-guard-report.json','runtime-execution-once.json','runtime.xcresult'])assert(!fs.existsSync(path.join(root,name)),'One attempt only: '+name);
const helper=require('/Users/thinkstu/Desktop/copy/FluentRead-mobile-video-menu-accessibility-20261016/scripts/testing/focus-safe-browser.cjs');
assert.equal(plan.runtimeCommit,'6eecd6710e7daac2d2a8cca9a34d0f26dc849b44');assert.equal(plan.newIdentity,path.join(shared,'identity-final-layout-flat.candidate.json'));assert.equal(plan.newIdentitySHA256,'3f74f268976e82aa7a84c5375938c89253ab461aa6585f5d18efec8164b04051');assert.equal(plan.newWebRawSHA256,'b1a66b3fc4e579216321758ebb921b7396430610119c9e5ca356de23b8cfc161');assert.equal(plan.newWebRecordSHA256,'14320cd02100962f0f593932a754cbdb5baa3ca25f073fece8bb6ea40a1a5be2');
const old=JSON.parse(fs.readFileSync(plan.oldIdentity)),probe=JSON.parse(fs.readFileSync(plan.newIdentity));
const report={startedAt:new Date().toISOString(),status:'PREFLIGHT',scope:'Production UI evidence; actual product runtime may perform already-authorized normal translation requests; manual screenshot review required',device:plan.UDID,commands:[],ownedPIDs:[],focusEvents:[],violations:[],cleanupErrors:[],processReadSamples:[],installsAttempted:0,restoresAttempted:0,testsSpawned:0,hostWindowOperations:[],permissionActions:[],directoryActions:[],resourcePolicy:plan.resourcePolicy};
let monitor,active,activeCleanup=false,interval,polling=false,violation,bootOwned=false,psFailure=false;
const start=Date.now(),end=start+540000,actionEnd=end-180000;
const save=()=>fs.writeFileSync(path.join(root,'runtime-guard-report.json'),JSON.stringify(report,null,2)+'\n');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function signal(child,sig='SIGTERM'){if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;try{process.kill(-child.pid,sig);}catch(e){if(e.code!=='ESRCH')report.cleanupErrors.push(String(e));}}
function stop(reason){if(!violation){violation=new Error(reason);report.violations.push({at:new Date().toISOString(),reason});save();}if(!activeCleanup){const target=active;signal(target);if(target)setTimeout(()=>signal(target,'SIGKILL'),1500).unref();}}
async function device(required,cleanup=false){const {stdout}=await exec('/usr/bin/xcrun',['simctl','list','devices','available','-j'],{timeout:15000,maxBuffer:2**20});const all=Object.values(JSON.parse(stdout).devices).flat(),found=all.filter(d=>d.udid===plan.UDID);assert.equal(found.length,1);assert.equal(found[0].name,plan.name);if(required)assert.equal(found[0].state,required);const foreignBooted=all.filter(d=>d.state==='Booted'&&d.udid!==plan.UDID).map(d=>({udid:d.udid,name:d.name,state:d.state}));if(cleanup){report.cleanupDeviceChecks??=[];report.cleanupDeviceChecks.push({at:new Date().toISOString(),owned:found[0],requiredState:required??null,foreignBooted,foreignDevicesTouched:false});save();}else assert.equal(foreignBooted.length,0,'External device is Booted; no action');return found[0];}
async function processes(){
 const begun=process.hrtime.bigint(),entry={startedAt:new Date().toISOString(),timeoutMs:10000};report.processReadSamples.push(entry);
 const pending=exec('/bin/ps',['-axo','pid=,pgid=,comm='],{timeout:10000,maxBuffer:2**20});entry.pid=pending.child?.pid??null;
 try{const {stdout,stderr}=await pending;Object.assign(entry,{outcome:'fulfilled',code:0,killed:false,signal:null,stdoutBytes:Buffer.byteLength(stdout),stderr});return stdout.split('\n').map(x=>x.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m=>({pid:+m[1],pgid:+m[2],executable:m[3]}));}
 catch(e){Object.assign(entry,{outcome:'rejected',code:e.code??null,killed:e.killed??null,signal:e.signal??null,error:String(e)});psFailure=true;throw e;}
 finally{entry.elapsedMs=Number(process.hrtime.bigint()-begun)/1e6;save();}
}
async function sample(){const rows=await processes();if(rows.some(p=>/(?:^|\/)Simulator$/.test(p.executable)))stop('Host Simulator GUI observed');if(active){const p=rows.find(p=>p.pid===active.pid);if(p&&p.pgid!==active.pid)stop('Owned process group mismatch');}if(monitor?.error)stop('Independent native focus observer failed');return rows;}
async function run(command,args,log,limit=30000,cleanup=false){
 if(!cleanup&&violation)throw violation;assert(Date.now()<(cleanup?end:actionEnd),'Phase budget exhausted');
 await device(cleanup?(log==='identity-after-shutdown.log'?'Shutdown':'Booted'):undefined,cleanup);
 const fd=fs.openSync(path.join(root,log),'wx'),child=cp.spawn(command,args,{cwd:root,env:process.env,detached:true,shell:false,stdio:['ignore',fd,fd]});fs.closeSync(fd);active=child;activeCleanup=cleanup;
 const record={command:[command,...args],log,pid:child.pid,pgid:child.pid,cleanup,startedAt:new Date().toISOString()};report.commands.push(record);report.ownedPIDs.push(child.pid);save();
 let kill;
 const timer=setTimeout(()=>{record.deadlineExceeded=true;signal(child);kill=setTimeout(()=>signal(child,'SIGKILL'),1500);},Math.min(limit,Math.max(1,(cleanup?end:actionEnd)-Date.now())));
 try{record.result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});assert.equal(record.result.code,0,log+' failed');if(!cleanup&&violation)throw violation;}
 finally{clearTimeout(timer);clearTimeout(kill);record.finishedAt=new Date().toISOString();active=null;activeCleanup=false;save();}
}
async function cleanupAction(name,action){try{await action();}catch(e){report.cleanupErrors.push(name+': '+String(e));save();}}
(async()=>{try{
 report.initialDevice=await device('Shutdown');
 monitor=helper.startFocusEventMonitor({onEvent:e=>{report.focusEvents.push(e);if(/^(Simulator|Xcode)$/i.test(e.name))stop('Protected host Simulator/Xcode activation');save();},onError:e=>stop('Native focus observer error: '+e)});report.observer=await monitor.ready;
 report.frontmostBefore=await helper.queryMacFrontmostApplication();assert(report.frontmostBefore&&!/^(Simulator|Xcode)$/i.test(report.frontmostBefore.name));await sample();if(violation)throw violation;
 fs.writeFileSync(path.join(root,'runtime-execution-once.json'),JSON.stringify({at:report.startedAt,planSHA256:runPlan.planSHA256,installLimit:1,restoreLimit:1,testLimit:1})+'\n',{flag:'wx'});
 interval=setInterval(()=>{if(polling||psFailure)return;polling=true;sample().catch(e=>stop('PID observer failed: '+String(e))).finally(()=>polling=false);},1000);
 await run('/usr/bin/python3',[path.join(root,'identity-check.py'),runDirectory,'before-boot'],'identity-before-boot.log');
 bootOwned=true;await run('/usr/bin/xcrun',['simctl','boot',plan.UDID],'boot.log');await run('/usr/bin/xcrun',['simctl','bootstatus',plan.UDID,'-b'],'bootstatus.log',60000);
 await device('Booted');await run('/usr/bin/python3',[path.join(root,'identity-check.py'),runDirectory,'before-install'],'identity-before-install.log');
 report.installsAttempted=1;save();await run('/usr/bin/xcrun',['simctl','install',plan.UDID,probe.app],'install-production-once.log',60000);
 await run('/usr/bin/python3',[path.join(root,'identity-check.py'),runDirectory,'after-install'],'identity-after-install.log');
 report.testsSpawned=1;save();await run(runPlan.command[0],runPlan.command.slice(1),'runtime-run.log',240000);
 const log=fs.readFileSync(path.join(root,'runtime-run.log'),'utf8');report.selectedCasePassed=log.includes(runPlan.testMethod+"]' passed");report.selectedCaseSkipped=log.includes(runPlan.testMethod+"]' skipped");report.executedOneTest=/Executed 1 test,/.test(log);assert(report.executedOneTest&&(report.selectedCasePassed||report.selectedCaseSkipped));
 report.status=report.selectedCaseSkipped?'UNVERIFIED_PRECONDITION_OR_AX_LIMIT':'UI_COMPLETED_PENDING_EVIDENCE_REVIEW';
 }catch(e){report.status=violation?'GUARD_ABORTED':'FAILED_OR_UNVERIFIED';report.error=e.stack||String(e);signal(active);}
 finally{
 // Preserve a bounded independent observer throughout exact same-bundle restoration. Violation stops evidence work;
 // cleanup only restores the original App and shuts down the owned device, without further UI actions.
 if(active){signal(active);await delay(1500);signal(active,'SIGKILL');}
 if(bootOwned){
  if(report.testsSpawned&&fs.existsSync(path.join(root,'runtime-run.log'))&&fs.readFileSync(path.join(root,'runtime-run.log'),'utf8').includes('FR_PRODUCTION_SAFARI_ACTIVATED')){
   await cleanupAction('Terminate owned Safari',()=>run('/usr/bin/xcrun',['simctl','terminate',plan.UDID,'com.apple.mobilesafari'],'terminate-owned-safari.log',15000,true));
  }
  if(report.installsAttempted){
   await cleanupAction('Restore exact original d9',async()=>{assert.equal(sha(plan.oldIdentity),plan.oldIdentitySHA256);report.restoresAttempted=1;save();await run('/usr/bin/xcrun',['simctl','install',plan.UDID,old.app],'restore-original-d9-once.log',60000,true);await run('/usr/bin/python3',[path.join(root,'identity-check.py'),runDirectory,'after-restore'],'identity-after-restore.log',30000,true);report.originalRestoredAndVerified=true;});
  }
  await cleanupAction('Shutdown owned A407',()=>run('/usr/bin/xcrun',['simctl','shutdown',plan.UDID],'shutdown.log',20000,true));
 }
 await cleanupAction('Final device',async()=>{report.finalDevice=await device(bootOwned?'Shutdown':undefined,true);});
 if(report.originalRestoredAndVerified)await cleanupAction('After-Shutdown exact-path hash verification',()=>run('/usr/bin/python3',[path.join(root,'identity-check.py'),runDirectory,'after-shutdown'],'identity-after-shutdown.log',25000,true));
 clearInterval(interval);while(polling)await delay(20);
 if(monitor){report.focusEvents=[...monitor.events];await cleanupAction('Stop observer',()=>monitor.stop());}
 await cleanupAction('Final PID/PGID and frontmost verification',async()=>{const rows=await processes();const latestPS=report.processReadSamples.at(-1)?.pid;const ids=new Set([...report.ownedPIDs,...report.processReadSamples.map(s=>s.pid).filter(pid=>pid&&pid!==latestPS),report.observer?.monitorPid].filter(Boolean));report.remainingOwnedProcesses=rows.filter(p=>ids.has(p.pid)||report.ownedPIDs.includes(p.pgid));report.finalPSCompleted=report.processReadSamples.at(-1)?.code===0;report.frontmostAfter=await helper.queryMacFrontmostApplication();assert(report.frontmostAfter&&!/^(Simulator|Xcode)$/i.test(report.frontmostAfter.name));assert.equal(report.remainingOwnedProcesses.length,0);});
 report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-start;report.laneReleased=report.finalDevice?.state==='Shutdown'&&report.remainingOwnedProcesses?.length===0;
 report.installedIdentityAtEnd=report.originalRestoredAndVerified?'ORIGINAL_D9_FULL485_VERIFIED':report.installsAttempted?'UNKNOWN_OR_NEW_PRODUCTION_MAY_REMAIN':'NO_NEW_PRODUCTION_INSTALL_ATTEMPTED';
 save();fs.writeFileSync(path.join(root,'cleanup.json'),JSON.stringify({laneReleased:report.laneReleased,finalDevice:report.finalDevice,originalRestoredAndVerified:report.originalRestoredAndVerified??false,installedIdentityAtEnd:report.installedIdentityAtEnd,remainingOwnedProcesses:report.remainingOwnedProcesses,focusEvents:report.focusEvents,violations:report.violations,cleanupErrors:report.cleanupErrors,elapsedMs:report.elapsedMs,privateScope:plan.privateBoundary},null,2)+'\n',{flag:'wx'});
 }
 console.log(JSON.stringify({status:report.status,installs:report.installsAttempted,restores:report.restoresAttempted,laneReleased:report.laneReleased,installedIdentityAtEnd:report.installedIdentityAtEnd,cleanupErrors:report.cleanupErrors,report:path.join(root,'runtime-guard-report.json')}));
 if(!['UNVERIFIED_PRECONDITION_OR_AX_LIMIT','UI_COMPLETED_PENDING_EVIDENCE_REVIEW'].includes(report.status)||!report.laneReleased||!report.originalRestoredAndVerified||report.cleanupErrors.length)process.exitCode=1;
})();
